import type { ProductInfo } from "@desafio/contracts";
import type { CallContext, ExternalResult } from "./results.js";

export type CatalogStatus = "ok" | "degraded" | "unavailable";

export interface ProductsLookup {
  products: ProductInfo[];
  status: CatalogStatus;
}

export interface ProductCatalogPort {
  getProduct(id: number, ctx?: CallContext): Promise<ExternalResult<ProductInfo>>;
  /** Parallel lookup. ok: all found; degraded: some missing; unavailable: none found. */
  getProducts(ids: readonly number[], ctx?: CallContext): Promise<ProductsLookup>;
}
