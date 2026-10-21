import { UNDERSTAND_PROMPT_VERSION } from "./understand.v1.js";
import { COMPOSE_PROMPT_VERSION } from "./compose.v1.js";

export * from "./understand.v1.js";
export * from "./compose.v1.js";

/** Versions to include in structured logs. */
export const PROMPT_VERSIONS = {
  understand: UNDERSTAND_PROMPT_VERSION,
  compose: COMPOSE_PROMPT_VERSION,
} as const;
