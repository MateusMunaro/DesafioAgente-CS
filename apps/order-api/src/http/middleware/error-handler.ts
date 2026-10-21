import type { NextFunction, Request, Response } from "express";
import { DomainError, OrderNotFoundError, TechnicalError, ValidationError } from "../../domain/errors.js";
import { getContext, sendError } from "../envelope.js";

/** Unknown route: same envelope, same code as a missing order. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new OrderNotFoundError());
}

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { type?: unknown; status?: unknown };
  return typeof e.type === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}

/** Maps every error to the standard envelope. Never leaks messages of unexpected errors. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const ctx = getContext(res);
  let domainError: DomainError;

  if (err instanceof DomainError) {
    domainError = err;
  } else if (isBodyParserError(err)) {
    domainError = new ValidationError([{ path: "body", issue: err.type === "entity.too.large" ? "is too large" : "is not valid JSON" }]);
  } else {
    domainError = new TechnicalError();
  }

  if (domainError instanceof TechnicalError) {
    // Only the error class and the pg/socket code: messages can embed row values (PII).
    const cause = (domainError.cause ?? err) as { name?: unknown; code?: unknown } | undefined;
    ctx.log.error({
      event: "order.unexpected_error",
      errorName: typeof cause?.name === "string" ? cause.name : "unknown",
      errorCode: typeof cause?.code === "string" ? cause.code : undefined,
      httpStatus: domainError.httpStatus,
    });
  }

  if (res.headersSent) {
    res.end();
    return;
  }
  sendError(res, domainError);
}
