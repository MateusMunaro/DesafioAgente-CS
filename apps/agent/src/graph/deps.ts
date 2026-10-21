import type { Logger } from "pino";
import type { IntentClassifier, ResponseComposer } from "../llm/types.js";
import type { CustomerDirectoryPort, HandoffPort, MessagingPort, OrderApiPort, ProductCatalogPort } from "../ports/index.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface RateLimiter {
  /** Registers one message for the key and returns false when the key is flooding. */
  hit(key: string): boolean;
}

export interface IdGenerator {
  uuid(): string;
}

export interface GraphDeps {
  orderApi: OrderApiPort;
  catalog: ProductCatalogPort;
  customers: CustomerDirectoryPort;
  messaging: MessagingPort;
  handoff: HandoffPort;
  classifier: IntentClassifier;
  composer: ResponseComposer;
  rateLimiter: RateLimiter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Names/terms that must never appear in a reply (other customers' data). */
  protectedTerms?: readonly string[];
  /** Confirmation validity in ms. Default 10 minutes (S5). */
  confirmationTtlMs?: number;
}

export const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const MAX_CLARIFY_ATTEMPTS = 2;
export const MAX_AMBIGUOUS_CONFIRMATIONS = 2;
export const MAX_INPUT_CHARS = 1000;
