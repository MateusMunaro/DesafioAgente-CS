import { pino, type Logger } from "pino";
import { REDACT_PATHS } from "./logging.js";

/** Logger writing JSON lines to memory so tests can assert on events and absence of PII. */
export function captureLogger(): { logger: Logger; lines: () => Array<Record<string, unknown>>; raw: () => string } {
  const chunks: string[] = [];
  const logger = pino(
    { level: "debug", base: { service: "agent" }, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    { write: (s: string) => void chunks.push(s) },
  );
  return {
    logger,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    raw: () => chunks.join(""),
  };
}

/**
 * fetch stand-in whose first `hangFirst` calls never answer until the caller aborts (a real timeout).
 * Later calls go to the global fetch (intercepted by nock). Records the headers of every call.
 */
export function hangingFetch(hangFirst: number): { fetchImpl: typeof fetch; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ ...(init?.headers as Record<string, string>) });
    if (calls.length > hangFirst) return fetch(input, init);
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
