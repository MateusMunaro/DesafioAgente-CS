import { randomUUID } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import pg from "pg";
import type { Logger } from "pino";
import { pino } from "pino";
import { StaticCustomerDirectory } from "../adapters/customers/staticCustomerDirectory.js";
import { FakeStoreClient } from "../adapters/fakestore/fakeStoreClient.js";
import { InMemoryHandoffService } from "../adapters/handoff/inMemoryHandoffService.js";
import { PgHandoffService } from "../adapters/handoff/pgHandoffService.js";
import { createLogger } from "../adapters/logging.js";
import { MockMessagingGateway } from "../adapters/messaging/mockMessagingGateway.js";
import { HttpOrderApiClient } from "../adapters/order-api/httpOrderApiClient.js";
import { buildSupportGraph, type SupportGraph } from "../graph/build.js";
import { systemClock, type GraphDeps } from "../graph/deps.js";
import { FakeIntentClassifier, FakeResponseComposer } from "../llm/fake.js";
import { createIntentClassifier, createResponseComposer } from "../llm/createChatModel.js";
import { createMemoryCheckpointer, createPostgresCheckpointer } from "../persistence/checkpointer.js";
import { InMemoryConversationStore, PgConversationStore, type ConversationStore } from "../persistence/conversationStore.js";
import { runAgentMigrations } from "../persistence/migrate.js";
import { AgentRuntime } from "./agentRuntime.js";
import { llmEnvFor, loadConfig, type AgentConfig } from "./config.js";
import { InMemoryOrderApi, StaticProductCatalog } from "./offline.js";
import { SlidingWindowRateLimiter, noRateLimit } from "./rateLimiter.js";

export interface Container {
  runtime: AgentRuntime;
  graph: SupportGraph;
  deps: GraphDeps;
  store: ConversationStore;
  messaging: MockMessagingGateway;
  /** Releases resources (database pool). Safe to call more than once. */
  close(): Promise<void>;
}

export interface ContainerParts {
  deps: GraphDeps;
  checkpointer: BaseCheckpointSaver;
  store: ConversationStore;
  messaging: MockMessagingGateway;
  close?: () => Promise<void>;
}

/** Single place where the object graph is wired. Every variant below ends here. */
export function assembleContainer(parts: ContainerParts): Container {
  const graph = buildSupportGraph(parts.deps, parts.checkpointer);
  const runtime = new AgentRuntime({
    graph,
    messaging: parts.deps.messaging,
    store: parts.store,
    rateLimiter: parts.deps.rateLimiter,
    logger: parts.deps.logger,
  });
  let closed = false;
  return {
    runtime,
    graph,
    deps: parts.deps,
    store: parts.store,
    messaging: parts.messaging,
    close: async () => {
      if (closed) return;
      closed = true;
      await parts.close?.();
    },
  };
}

const silentLogger = (): Logger => pino({ level: "silent" });

export type TestContainerOverrides = Partial<GraphDeps> & {
  checkpointer?: BaseCheckpointSaver;
  store?: ConversationStore;
  messaging?: MockMessagingGateway;
};

/** In-memory variant for tests: fake LLM, in-memory Order API and checkpoints, silent logs, no rate limit. */
export function createTestContainer(o: TestContainerOverrides = {}): Container & { orderApi: InMemoryOrderApi } {
  const { checkpointer, store, messaging: messagingOverride, ...depOverrides } = o;
  const logger = depOverrides.logger ?? silentLogger();
  const messaging = messagingOverride ?? new MockMessagingGateway({ logger });
  const orderApi = (depOverrides.orderApi as InMemoryOrderApi | undefined) ?? new InMemoryOrderApi();
  const deps: GraphDeps = {
    orderApi,
    catalog: new StaticProductCatalog(),
    customers: new StaticCustomerDirectory(),
    messaging,
    handoff: new InMemoryHandoffService({ logger }),
    classifier: new FakeIntentClassifier(),
    composer: new FakeResponseComposer(),
    rateLimiter: noRateLimit,
    clock: systemClock,
    ids: { uuid: randomUUID },
    logger,
    ...depOverrides,
  };
  deps.messaging = messaging;
  const c = assembleContainer({
    deps,
    checkpointer: checkpointer ?? createMemoryCheckpointer(),
    store: store ?? new InMemoryConversationStore(),
    messaging,
  });
  return Object.assign(c, { orderApi });
}

/**
 * Chat simulator variant: real Order API and Fake Store over HTTP unless offline; checkpoints, conversations and
 * tickets stay in memory (no database needed). The LLM follows LLM_PROVIDER.
 */
export function createCliContainer(env: NodeJS.ProcessEnv = process.env, offline = false): Container & { orderApi: InMemoryOrderApi | null } {
  if (offline) return createOfflineContainer(env);
  const cfg = loadConfig(env);
  const logger = createLogger();
  logger.level = cfg.LOG_LEVEL;
  const messaging = new MockMessagingGateway({ logger });
  const deps: GraphDeps = {
    orderApi: new HttpOrderApiClient({ baseUrl: cfg.ORDER_API_URL, token: cfg.ORDER_API_TOKEN, logger }),
    catalog: new FakeStoreClient({ baseUrl: cfg.FAKESTORE_URL, logger }),
    customers: new StaticCustomerDirectory(),
    messaging,
    handoff: new InMemoryHandoffService({ logger }),
    classifier: createIntentClassifier(llmEnvFor("understand", cfg)),
    composer: createResponseComposer(llmEnvFor("compose", cfg)),
    rateLimiter: new SlidingWindowRateLimiter(),
    clock: systemClock,
    ids: { uuid: randomUUID },
    logger,
  };
  const c = assembleContainer({ deps, checkpointer: createMemoryCheckpointer(), store: new InMemoryConversationStore(), messaging });
  return Object.assign(c, { orderApi: null });
}

/** Offline variant (CLI --offline): in-memory adapters, LLM chosen by LLM_PROVIDER. */
export function createOfflineContainer(env: NodeJS.ProcessEnv = process.env): Container & { orderApi: InMemoryOrderApi } {
  const cfg = loadConfig({ ...env, LLM_PROVIDER: env.LLM_PROVIDER ?? "fake" });
  const logger = createLogger();
  logger.level = cfg.LOG_LEVEL;
  const messaging = new MockMessagingGateway({ logger });
  const orderApi = new InMemoryOrderApi();
  const deps: GraphDeps = {
    orderApi,
    catalog: new StaticProductCatalog(),
    customers: new StaticCustomerDirectory(),
    messaging,
    handoff: new InMemoryHandoffService({ logger }),
    classifier: createIntentClassifier(llmEnvFor("understand", cfg)),
    composer: createResponseComposer(llmEnvFor("compose", cfg)),
    rateLimiter: new SlidingWindowRateLimiter(),
    clock: systemClock,
    ids: { uuid: randomUUID },
    logger,
  };
  const c = assembleContainer({ deps, checkpointer: createMemoryCheckpointer(), store: new InMemoryConversationStore(), messaging });
  return Object.assign(c, { orderApi });
}

/** Production variant: Order API over HTTP, Fake Store, Postgres (schema agent) for checkpoints, conversations and tickets. */
export async function createProductionContainer(env: NodeJS.ProcessEnv = process.env, cfgIn?: AgentConfig): Promise<Container> {
  const cfg = cfgIn ?? loadConfig(env);
  if (!cfg.databaseUrl) throw new Error("DATABASE_URL (or AGENT_DATABASE_URL) is required");
  const logger = createLogger();
  logger.level = cfg.LOG_LEVEL;
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  try {
    await runAgentMigrations(pool);
    const checkpointer = await createPostgresCheckpointer(pool);
    const messaging = new MockMessagingGateway({ logger });
    const deps: GraphDeps = {
      orderApi: new HttpOrderApiClient({ baseUrl: cfg.ORDER_API_URL, token: cfg.ORDER_API_TOKEN, logger }),
      catalog: new FakeStoreClient({ baseUrl: cfg.FAKESTORE_URL, logger }),
      customers: new StaticCustomerDirectory(),
      messaging,
      handoff: new PgHandoffService(pool, { logger }),
      classifier: createIntentClassifier(llmEnvFor("understand", cfg)),
      composer: createResponseComposer(llmEnvFor("compose", cfg)),
      rateLimiter: new SlidingWindowRateLimiter(),
      clock: systemClock,
      ids: { uuid: randomUUID },
      logger,
    };
    return assembleContainer({ deps, checkpointer, store: new PgConversationStore(pool), messaging, close: () => pool.end() });
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
}
