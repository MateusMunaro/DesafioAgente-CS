import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError } from "../../domain/errors.js";
import { getContext } from "../envelope.js";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Service-to-service Bearer auth. Constant-time comparison; the token is never logged. */
export function bearerAuth(expectedToken: string) {
  const expected = digest(expectedToken);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization");
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const provided = match?.[1];
    if (provided !== undefined && timingSafeEqual(digest(provided), expected)) {
      next();
      return;
    }
    getContext(res).log.warn({ event: "auth.rejected", reason: provided === undefined ? "MISSING" : "INVALID", httpStatus: 401 });
    next(new UnauthorizedError());
  };
}
