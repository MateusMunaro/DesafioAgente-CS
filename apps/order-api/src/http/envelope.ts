import type { ErrorEnvelope, SuccessEnvelope } from "@desafio/contracts";
import type { Response } from "express";
import type { RequestContext } from "../application/order-service.js";
import type { DomainError } from "../domain/errors.js";

export function getContext(res: Response): RequestContext {
  return res.locals.ctx as RequestContext;
}

export function sendSuccess<T>(res: Response, code: SuccessEnvelope<T>["code"], message: string, data: T, status = 200): void {
  const body: SuccessEnvelope<T> = { ok: true, code, message, data, requestId: getContext(res).requestId };
  res.status(status).json(body);
}

export function sendError(res: Response, err: DomainError): void {
  const body: ErrorEnvelope = {
    ok: false,
    code: err.code,
    message: err.message,
    details: err.details,
    requestId: getContext(res).requestId,
  };
  res.status(err.httpStatus).json(body);
}
