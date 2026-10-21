import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "express";
import swaggerUi from "swagger-ui-express";
import { parse } from "yaml";

// Same relative path from src/http (tsx/vitest) and dist/http (compiled).
export const OPENAPI_PATH = fileURLToPath(new URL("../../openapi.yaml", import.meta.url));

export function loadOpenApiDocument(): Record<string, unknown> {
  return parse(readFileSync(OPENAPI_PATH, "utf8")) as Record<string, unknown>;
}

/** Swagger UI handlers to mount at /docs. */
export function docsHandlers(): RequestHandler[] {
  return [...swaggerUi.serve, swaggerUi.setup(loadOpenApiDocument(), { customSiteTitle: "Order API" })];
}
