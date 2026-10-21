import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OrderStatus } from "@desafio/contracts";
import nock from "nock";
import { captureLogger } from "../../src/adapters/testUtils.js";
import { FakeStoreClient } from "../../src/adapters/fakestore/fakeStoreClient.js";
import { InMemoryHandoffService } from "../../src/adapters/handoff/inMemoryHandoffService.js";
import { HttpOrderApiClient } from "../../src/adapters/order-api/httpOrderApiClient.js";
import { ANA, CountingOrderApi, ManualClock, SpyClassifier, SpyComposer, events } from "../../src/graph/testing.js";
import type { IntentClassifier, ResponseComposer } from "../../src/llm/types.js";
import type { ApiResult, OrderApiPort, ProductCatalogPort } from "../../src/ports/index.js";
import { createTestContainer, type Container } from "../../src/runtime/container.js";
import { InMemoryOrderApi, OFFLINE_ORDERS, StaticProductCatalog } from "../../src/runtime/offline.js";
import { threadIdFor } from "../../src/runtime/threadId.js";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import path from "node:path";

export type Backend = "memory" | "real";

export const FAKESTORE_URL = "http://fakestore.test";
const ORDER_API_TOKEN = "scenario-token";

/** Fake Store payloads as the real service sends them (id, title, price, description, category, image, rating). */
const FAKESTORE_PRODUCTS: Record<number, { title: string; category: string; price: number }> = {
  1: { title: "Fjallraven - Foldsack No. 1 Backpack", category: "men's clothing", price: 109.95 },
  2: { title: "Mens Casual Premium Slim Fit T-Shirts", category: "men's clothing", price: 22.3 },
  3: { title: "Mens Cotton Jacket", category: "men's clothing", price: 55.99 },
  5: { title: "John Hardy Women's Legends Naga Bracelet", category: "jewelery", price: 695 },
  9: { title: "WD 2TB Elements Portable External Hard Drive", category: "electronics", price: 64 },
  10: { title: "SanDisk SSD PLUS 1TB Internal SSD", category: "electronics", price: 109 },
  13: { title: "Acer SB220Q bi 21.5 inches Full HD Monitor", category: "electronics", price: 599 },
  14: { title: "Samsung 49-Inch CHG90 Gaming Monitor", category: "electronics", price: 999.99 },
  19: { title: "Women's Short Sleeve Moisture T-Shirt", category: "women's clothing", price: 7.95 },
};

export interface StackOptions {
  backend: Backend;
  /** Fake Store behaviour. Default "up". */
  fakeStore?: "up" | "down" | "malformed";
  /** Replaces product titles (Fake Store payloads, or the static catalog in memory mode). */
  titles?: Record<number, string>;
  /** Extra field added to every Fake Store payload (e.g. a malicious `description`). Real backend only. */
  description?: string;
  /** Faults on the cancel call. "timeout": no answer at all; "lost-response": the API executes but the answer never arrives (first attempt only). */
  cancelFault?: "timeout" | "lost-response";
  classifier?: IntentClassifier;
  composer?: ResponseComposer;
}

export interface HttpCall {
  method: string;
  path: string;
  idempotencyKey: string | null;
}

export interface Stack {
  backend: Backend;
  container: Container;
  say: (text: string, from?: string, channel?: string) => ReturnType<Container["runtime"]["handleInbound"]>;
  clock: ManualClock;
  log: ReturnType<typeof captureLogger>;
  /** Order API logs (real backend only; empty in memory mode). */
  orderApiLog: ReturnType<typeof captureOrderApiLogs>;
  orderApi: CountingOrderApi;
  classifier: SpyClassifier;
  composer: SpyComposer;
  handoff: InMemoryHandoffService;
  /** Cancel (POST) calls as seen by the Order API. Real backend: HTTP level, one entry per attempt. */
  posts: () => HttpCall[];
  /** Every call that reached the Order API, GET and POST. */
  calls: () => HttpCall[];
  /** Ground truth status in the Order API's own storage. */
  statusOf: (orderId: string) => Promise<OrderStatus | undefined>;
  /** Moves an order to another status behind the agent's back (shipping, TC-08). */
  setStatus: (orderId: string, status: OrderStatus) => void;
  /** Number of cancellations the Order API actually executed. */
  cancellationsExecuted: () => Promise<number>;
  /** Pending cancel action saved in the checkpoint, if any. */
  pending: (phone?: string) => Promise<{ orderId: string; idempotencyKey: string; expiresAt: string } | null>;
  /** True when the graph is paused on the confirmation interrupt. */
  paused: (phone?: string) => Promise<boolean>;
  close: () => Promise<void>;
}

function captureOrderApiLogs() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, raw: () => chunks.join("") };
}

function toOrder(api: OrderApiModules, seed: (typeof OFFLINE_ORDERS)[number]): unknown {
  const shipped = seed.status === "SHIPPED" || seed.status === "DELIVERED";
  const total = seed.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  return api.createOrder({
    id: seed.id,
    customerId: seed.customerRef,
    status: seed.status,
    totalAmount: Math.round(total * 100) / 100,
    currency: "BRL",
    items: seed.items.map((i) => ({ productExternalId: i.productId, productTitle: i.title, quantity: i.quantity, unitPrice: i.unitPrice })),
    createdAt: new Date(seed.createdAt),
    shippedAt: shipped ? new Date(seed.createdAt) : null,
    cancelledAt: seed.status === "CANCELLED" ? new Date(seed.createdAt) : null,
  });
}

/** Never answers until the caller aborts (a real timeout). */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}


/**
 * The real Order API (Express app + in-memory repository) runs inside this process. It lives in another workspace
 * (outside this package's tsconfig rootDir), so it is loaded at runtime by path instead of through a static import.
 */
interface OrderApiRepoLike {
  history: unknown[];
  snapshot(id: string): { status: OrderStatus } | undefined;
  setStatus(id: string, status: OrderStatus): void;
}
interface OrderApiModules {
  createApp(deps: { repository: unknown; logger: unknown; apiToken: string }): { listen(port: number, host: string, cb: () => void): Server };
  createRepository(orders: unknown[]): OrderApiRepoLike;
  createOrder(fields: Record<string, unknown>): unknown;
  createLogger(o: { level: string; destination: Writable }): unknown;
}

async function loadOrderApi(): Promise<OrderApiModules> {
  const src = path.resolve(import.meta.dirname, "../../../order-api/src");
  const load = (rel: string): Promise<Record<string, any>> => import(/* @vite-ignore */ pathToFileURL(path.join(src, rel)).href);
  const [app, repo, order, logger] = await Promise.all([load("http/app.ts"), load("infra/in-memory-order-repository.ts"), load("domain/order.ts"), load("infra/logger.ts")]);
  return {
    createApp: app.createApp,
    createRepository: (orders) => new repo.InMemoryOrderRepository(orders),
    createOrder: (fields) => new order.Order(fields),
    createLogger: logger.createLogger,
  };
}

const open: Stack[] = [];

/** Closes every stack created since the last call. Use in afterEach. */
export async function closeStacks(): Promise<void> {
  nock.cleanAll();
  await Promise.all(open.splice(0).map((s) => s.close()));
}

export function setupNetwork(): void {
  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
}

function mockFakeStore(o: StackOptions): void {
  const mode = o.fakeStore ?? "up";
  nock(FAKESTORE_URL)
    .persist()
    .get(/^\/products\/\d+$/)
    .reply(function reply(uri: unknown) {
      const raw = typeof uri === "string" ? uri : (uri as unknown as { url: string }).url;
      const id = Number(new URL(raw, FAKESTORE_URL).pathname.split("/").pop());
      if (mode === "down") return [500, { error: "boom" }];
      if (mode === "malformed") return [200, "{not json"];
      const p = FAKESTORE_PRODUCTS[id];
      if (!p) return [200, ""]; // the real Fake Store answers 200 with an empty body for unknown ids
      return [
        200,
        {
          id,
          title: o.titles?.[id] ?? p.title,
          price: p.price,
          description: o.description ?? "A very nice product.",
          category: p.category,
          image: "https://fakestoreapi.com/img/x.jpg",
          rating: { rate: 4.1, count: 120 },
        },
      ];
    });
}

export async function buildStack(o: StackOptions): Promise<Stack> {
  const log = captureLogger();
  const clock = new ManualClock();
  const classifier = new SpyClassifier(o.classifier);
  const composer = new SpyComposer(o.composer);
  const handoff = new InMemoryHandoffService({ logger: log.logger });
  const orderApiLog = captureOrderApiLogs();
  const httpCalls: HttpCall[] = [];

  let server: Server | null = null;
  let repo: OrderApiRepoLike | null = null;
  let inner: InMemoryOrderApi | null = null;
  let port: OrderApiPort;
  let catalog: ProductCatalogPort;

  if (o.backend === "real") {
    const api = await loadOrderApi();
    repo = api.createRepository(OFFLINE_ORDERS.map((o) => toOrder(api, o)));
    const app = api.createApp({
      repository: repo,
      logger: api.createLogger({ level: "debug", destination: orderApiLog.stream }),
      apiToken: ORDER_API_TOKEN,
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let postAttempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      httpCalls.push({ method, path: url.pathname, idempotencyKey: headers["Idempotency-Key"] ?? null });
      if (method === "POST") {
        postAttempts++;
        if (o.cancelFault === "timeout") return hang(init);
        if (o.cancelFault === "lost-response" && postAttempts === 1) {
          await fetch(input, init); // the server executes the cancellation...
          return hang(init); // ...but the answer never arrives
        }
      }
      return fetch(input, init);
    }) as typeof fetch;
    port = new HttpOrderApiClient({ baseUrl, token: ORDER_API_TOKEN, timeoutMs: 250, logger: log.logger, fetchImpl });
    mockFakeStore(o);
    catalog = new FakeStoreClient({ baseUrl: FAKESTORE_URL, logger: log.logger, backoffMs: 1, timeoutMs: 500 });
  } else {
    inner = new InMemoryOrderApi();
    const base = inner;
    port = {
      getOrder: (...a) => base.getOrder(...a),
      cancel: async (...a): Promise<ApiResult<never>> => {
        if (o.cancelFault) return { kind: "TECHNICAL_ERROR", cause: "TIMEOUT", attempts: 2 };
        return base.cancel(...a) as never;
      },
    };
    const products = (await new StaticProductCatalog().getProducts([1, 2, 3, 5, 9, 10, 13, 14, 19])).products.map((p) => ({
      ...p,
      title: o.titles?.[p.id] ?? p.title,
    }));
    catalog = new StaticProductCatalog(products, o.fakeStore === "down" || o.fakeStore === "malformed");
  }

  const orderApi = new CountingOrderApi(port);
  const container = createTestContainer({
    logger: log.logger,
    clock,
    orderApi,
    catalog,
    classifier,
    composer,
    handoff,
  });

  const memoryStatus = async (id: string): Promise<OrderStatus | undefined> => {
    const seed = OFFLINE_ORDERS.find((x) => x.id === id);
    if (!seed || !inner) return undefined;
    const r = await inner.getOrder(seed.customerRef, id);
    return r.kind === "OK" ? r.data.status : undefined;
  };

  const getState = (phone: string) => container.graph.getState({ configurable: { thread_id: threadIdFor("wa", phone) } });

  const stack: Stack = {
    backend: o.backend,
    container,
    say: (text, from = ANA.phoneE164, channel = "wa") => container.runtime.handleInbound({ channel, from, text }),
    clock,
    log,
    orderApiLog,
    orderApi,
    classifier,
    composer,
    handoff,
    posts: () =>
      o.backend === "real"
        ? httpCalls.filter((c) => c.method === "POST")
        : orderApi.cancels.map((c) => ({ method: "POST", path: `/orders/${c.orderId}/cancellation`, idempotencyKey: c.key })),
    calls: () =>
      o.backend === "real"
        ? [...httpCalls]
        : [
            ...Array.from({ length: orderApi.gets }, () => ({ method: "GET", path: "/orders/*", idempotencyKey: null })),
            ...orderApi.cancels.map((c) => ({ method: "POST", path: `/orders/${c.orderId}/cancellation`, idempotencyKey: c.key })),
          ],
    statusOf: (id) => Promise.resolve(repo ? repo.snapshot(id)?.status : undefined).then((r) => r ?? memoryStatus(id)),
    setStatus: (id, status) => (repo ? repo.setStatus(id, status) : inner?.setStatus(id, status)),
    cancellationsExecuted: async () => {
      if (repo) return repo.history.length;
      let n = 0;
      for (const seed of OFFLINE_ORDERS) if (seed.status !== "CANCELLED" && (await memoryStatus(seed.id)) === "CANCELLED") n++;
      return n;
    },
    pending: async (phone = ANA.phoneE164) => {
      const snap = await getState(phone);
      return (snap.values as { pendingAction: { orderId: string; idempotencyKey: string; expiresAt: string } | null }).pendingAction;
    },
    paused: async (phone = ANA.phoneE164) => {
      const snap = await getState(phone);
      return snap.next.includes("confirm");
    },
    close: async () => {
      await container.close();
      if (server) await new Promise<void>((r) => server?.close(() => r()));
    },
  };
  open.push(stack);
  return stack;
}

export { ANA, events };
