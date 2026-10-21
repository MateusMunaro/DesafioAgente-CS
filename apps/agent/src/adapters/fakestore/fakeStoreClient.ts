import { ProductInfo, type ProductInfo as ProductInfoT } from "@desafio/contracts";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import type { CallContext, ExternalFailure, ExternalResult, ProductCatalogPort, ProductsLookup } from "../../ports/index.js";
import { fetchJson, sleep } from "../http.js";
import { createLogger, type Logger } from "../logging.js";
import { MAX_CATEGORY_CHARS, MAX_TITLE_CHARS, sanitizeText } from "./sanitize.js";

export interface FakeStoreClientOptions {
  baseUrl?: string;
  /** Per attempt deadline. Default 2000 ms. */
  timeoutMs?: number;
  /** Extra attempts after the first one. Default 1. */
  retries?: number;
  /** Base backoff; attempt n waits backoffMs * 2^(n-1). Default 200 ms. */
  backoffMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** Shape accepted from the wire. `description` (and anything else) is dropped by zod and never read. */
const RawProduct = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  category: z.string(),
  price: z.number().finite().nonnegative(),
});

export class FakeStoreClient implements ProductCatalogPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: LRUCache<number, ProductInfoT>;

  constructor(o: FakeStoreClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? "https://fakestoreapi.com").replace(/\/+$/, "");
    this.timeoutMs = o.timeoutMs ?? 2000;
    this.retries = o.retries ?? 1;
    this.backoffMs = o.backoffMs ?? 200;
    this.log = o.logger ?? createLogger();
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.cache = new LRUCache<number, ProductInfoT>({ max: o.cacheMaxEntries ?? 100, ttl: o.cacheTtlMs ?? 10 * 60 * 1000 });
  }

  async getProduct(id: number, ctx: CallContext = {}): Promise<ExternalResult<ProductInfoT>> {
    if (!Number.isInteger(id) || id <= 0) return { kind: "UNAVAILABLE", reason: "NOT_FOUND" };
    const hit = this.cache.get(id);
    if (hit) {
      this.log.debug({ event: "external.fakestore.cache_hit", productId: id, traceId: ctx.traceId });
      return { kind: "OK", data: { ...hit }, cached: true };
    }

    const maxAttempts = 1 + this.retries;
    let reason: ExternalFailure = "NETWORK";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const out = await fetchJson(`${this.baseUrl}/products/${id}`, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        method: "GET",
        headers: { Accept: "application/json" },
      });
      let retryable = false;
      if (out.kind === "timeout") {
        reason = "TIMEOUT";
        retryable = true;
      } else if (out.kind === "network") {
        reason = "NETWORK";
        retryable = true;
      } else if (out.status >= 500) {
        reason = "HTTP_ERROR";
        retryable = true;
      } else if (out.status === 404) {
        reason = "NOT_FOUND";
      } else if (out.status !== 200) {
        reason = "HTTP_ERROR";
      } else {
        const product = out.bodyValid ? toSafeProduct(out.body, id) : undefined;
        if (product) {
          this.cache.set(id, product);
          return { kind: "OK", data: { ...product }, cached: false };
        }
        // Empty body (the Fake Store answers 200 + empty for unknown ids), wrong types or missing fields.
        reason = "INVALID_RESPONSE";
      }
      const willRetry = retryable && attempt < maxAttempts;
      this.log.warn({ event: "external.fakestore.failed", productId: id, traceId: ctx.traceId, error: reason, attempt, durationMs: Date.now() - started, willRetry });
      if (!willRetry) break;
      await sleep(this.backoffMs * 2 ** (attempt - 1));
    }
    return { kind: "UNAVAILABLE", reason };
  }

  async getProducts(ids: readonly number[], ctx: CallContext = {}): Promise<ProductsLookup> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { products: [], status: "ok" };
    const settled = await Promise.allSettled(unique.map((id) => this.getProduct(id, ctx)));
    const products: ProductInfoT[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.kind === "OK") products.push(s.value.data);
    }
    const status = products.length === unique.length ? "ok" : products.length === 0 ? "unavailable" : "degraded";
    if (status !== "ok") this.log.warn({ event: "external.fakestore.degraded", requested: unique.length, found: products.length, status, traceId: ctx.traceId });
    return { products, status };
  }
}

/** Builds the only object that may leave this adapter: id, title, category, price. */
function toSafeProduct(body: unknown, expectedId: number): ProductInfoT | undefined {
  const raw = RawProduct.safeParse(body);
  if (!raw.success || raw.data.id !== expectedId) return undefined;
  const safe = ProductInfo.safeParse({
    id: raw.data.id,
    title: sanitizeText(raw.data.title, MAX_TITLE_CHARS),
    category: sanitizeText(raw.data.category, MAX_CATEGORY_CHARS),
    price: raw.data.price,
  });
  return safe.success ? safe.data : undefined;
}
