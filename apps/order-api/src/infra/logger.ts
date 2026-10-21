import { pino, type DestinationStream, type Logger } from "pino";

/** Fields that can carry personal data or secrets. They are censored wherever they show up. */
export const REDACT_PATHS = [
  "authorization",
  "token",
  "phone",
  "phoneE164",
  "phone_e164",
  "displayName",
  "display_name",
  "name",
  "body",
  "*.authorization",
  "*.token",
  "*.phone",
  "*.phoneE164",
  "*.phone_e164",
  "*.displayName",
  "*.display_name",
  "*.name",
  "*.body",
  "req.headers.authorization",
  'req.headers["x-customer-ref"]',
  "headers.authorization",
];

export interface LoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { service: "order-api" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
    options.destination,
  );
}
