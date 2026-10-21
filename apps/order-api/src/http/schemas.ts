import { ORDER_ID_REGEX } from "@desafio/contracts";
import { z } from "zod";
import { ValidationError, type FieldIssue } from "../domain/errors.js";

const FIELD_LABEL: Record<string, string> = {
  id: "id",
  customerRef: "X-Customer-Ref",
  idempotencyKey: "Idempotency-Key",
  channel: "channel",
  reasonCode: "reasonCode",
};

const OrderIdSchema = z.string().regex(ORDER_ID_REGEX, "must be 4 to 10 digits");
const CustomerRefSchema = z.uuid("must be a UUID");
const IdempotencyKeySchema = z.string().min(8, "must be 8 to 128 characters").max(128, "must be 8 to 128 characters");

export const GetOrderInput = z.object({ id: OrderIdSchema, customerRef: CustomerRefSchema });
export const CancelOrderInput = z.object({
  id: OrderIdSchema,
  customerRef: CustomerRefSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const CancellationBody = z
  .object({
    channel: z.string().max(32, "must be at most 32 characters").optional(),
    reasonCode: z.string().max(64, "must be at most 64 characters").optional(),
  })
  .strict();

function toIssues(error: z.ZodError, prefix = ""): FieldIssue[] {
  return error.issues.map((issue) => {
    const raw = issue.path.map(String).join(".");
    const label = FIELD_LABEL[raw] ?? raw;
    const path = prefix ? (label ? `${prefix}.${label}` : prefix) : label || "(root)";
    let text = issue.message;
    if (issue.code === "invalid_type") text = issue.input === undefined ? "is required" : "has an invalid type";
    if (issue.code === "unrecognized_keys") text = `unknown field(s): ${issue.keys.join(", ")}`;
    return { path, issue: text };
  });
}

/** Parses `data` and throws a ValidationError (400) listing every offending field. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown, prefix = ""): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(toIssues(result.error, prefix));
  return result.data;
}

/** Validates params, headers and optional body together so the client sees all problems at once. */
export function parseCancelRequest(input: { id: unknown; customerRef: unknown; idempotencyKey: unknown; body: unknown }) {
  const issues: FieldIssue[] = [];
  const head = CancelOrderInput.safeParse({ id: input.id, customerRef: input.customerRef, idempotencyKey: input.idempotencyKey });
  if (!head.success) issues.push(...toIssues(head.error));

  let body: z.infer<typeof CancellationBody> = {};
  if (input.body !== undefined) {
    const parsed = CancellationBody.safeParse(input.body);
    if (parsed.success) body = parsed.data;
    else issues.push(...toIssues(parsed.error, "body"));
  }
  if (issues.length > 0 || !head.success) throw new ValidationError(issues);
  return { ...head.data, body };
}
