import { execFileSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgHandoffService } from "../adapters/handoff/pgHandoffService.js";
import { ANA, ManualClock, harness } from "../graph/testing.js";
import { createTestContainer } from "../runtime/container.js";
import { InMemoryOrderApi } from "../runtime/offline.js";
import { createPostgresCheckpointer } from "./checkpointer.js";
import { PgConversationStore } from "./conversationStore.js";
import { runAgentMigrations } from "./migrate.js";
import { captureLogger } from "../adapters/testUtils.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn("[agent] Docker is not available: skipping Testcontainers integration tests (agent schema, PostgresSaver).");
}

describe.skipIf(!hasDocker)("agent schema + PostgresSaver (Postgres via Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runAgentMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("migrations are idempotent", async () => {
    expect(await runAgentMigrations(pool)).toEqual([]);
  });

  it("a cancellation paused in turn 1 resumes in turn 2 from the Postgres checkpoint, with redacted persistence", async () => {
    const checkpointer = await createPostgresCheckpointer(pool);
    const clock = new ManualClock();
    const orderApi = new InMemoryOrderApi();
    const log = captureLogger();
    const make = () =>
      createTestContainer({
        checkpointer,
        orderApi,
        clock,
        logger: log.logger,
        store: new PgConversationStore(pool),
        handoff: new PgHandoffService(pool, { logger: log.logger }),
      });
    const first = await make().runtime.handleInbound({ channel: "wa", from: ANA.phoneE164, text: "cancela o pedido 1042, meu email e ana@example.com" });
    expect(first.awaitingConfirmation).toBe(true);
    const second = await make().runtime.handleInbound({ channel: "wa", from: ANA.phoneE164, text: "sim" });
    expect(second.reply).toContain("foi cancelado");
    expect(orderApi.cancelCalls).toHaveLength(1);

    const msgs = (await pool.query("SELECT direction, body_redacted FROM agent.messages WHERE thread_id = $1 ORDER BY id", [first.threadId])).rows;
    expect(msgs.map((m) => m.direction)).toEqual(["IN", "OUT", "IN", "OUT"]);
    expect(msgs.map((m) => m.body_redacted).join(" ")).not.toContain("ana@example.com");

    const third = await make().runtime.handleInbound({ channel: "wa", from: ANA.phoneE164, text: "quero falar com um atendente" });
    expect(third.handoff).toBe(true);
    const tickets = (await pool.query("SELECT reason, status FROM agent.handoff_tickets WHERE thread_id = $1", [first.threadId])).rows;
    expect(tickets).toEqual([{ reason: "USER_REQUEST", status: "OPEN" }]);
    const conv = (await pool.query("SELECT status FROM agent.conversations WHERE thread_id = $1", [first.threadId])).rows[0];
    expect(conv.status).toBe("HANDOFF");
  });

  it("harness helper still works alongside (sanity)", async () => {
    expect((await harness().say("oi")).reply).toMatch(/Ola/);
  });
});
