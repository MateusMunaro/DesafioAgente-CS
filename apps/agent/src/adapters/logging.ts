import { pino, type Logger } from "pino";

/** Fields removed from every log line. Adapters also never log them in the first place. */
export const REDACT_PATHS = ["phone", "to", "name", "displayName", "body", "text", "message", "token", "authorization", "*.phone", "*.token", "*.authorization", "headers.authorization"];

export function createLogger(destination?: pino.DestinationStream): Logger {
  return pino(
    { level: process.env.LOG_LEVEL ?? "info", base: { service: "agent" }, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    destination,
  );
}

export type { Logger };
