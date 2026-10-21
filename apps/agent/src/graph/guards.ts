import { CUSTOMER_FIXTURES } from "@desafio/contracts";
import { COMPOSE_SYSTEM_PROMPT_V1 } from "../prompts/compose.v1.js";
import { UNDERSTAND_SYSTEM_PROMPT_V1 } from "../prompts/understand.v1.js";
import { templates } from "../templates/index.js";
import { MAX_INPUT_CHARS } from "./deps.js";
import type { AgentStateType, InputVerdict } from "./state.js";

// ---------------------------------------------------------------- input guard

/** Pure input checks. `flooding` comes from the rate limiter (per thread). */
export function checkInput(text: string, flooding: boolean): InputVerdict {
  if (!text || text.trim().length === 0) return { ok: false, reason: "EMPTY" };
  if (text.length > MAX_INPUT_CHARS) return { ok: false, reason: "TOO_LONG" };
  if (flooding) return { ok: false, reason: "FLOOD" };
  return { ok: true };
}

// --------------------------------------------------------------- output guard

export type OutputRule =
  | "EMPTY_REPLY"
  | "REPLY_TOO_LONG"
  | "CLAIMED_CANCEL_WITHOUT_SUCCESS"
  | "WRONG_ORDER_NUMBER"
  | "PROMPT_LEAK"
  | "OTHER_CUSTOMER_DATA";

export type GuardResult = { ok: true } | { ok: false; rule: OutputRule };

export const MAX_REPLY_CHARS = 1000;

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

const CANCEL_CLAIM =
  /\b(cancelad[oa]s?|cancelei|cancelamos|cancelaram|cancelou|cancelamento(?:\s+\S+){0,6}?\s+(?:(?:ja\s+)?(?:foi|esta|estao|foram)\s+)?(?:concluido|realizado|efetuado|efetivado|feito|confirmado|processado|finalizado|aprovado))\b/g;
const NEG = "(?:nao|nunca|jamais|nada|nenhum|nenhuma)";
/**
 * Words allowed between a negation and the cancel verb ("nao pode ser cancelado", "nada foi cancelado").
 * Anything else breaks the link, so "nao se preocupe que cancelei" or "nunca chegou porque foi
 * cancelado" are still claims.
 */
const AUX =
  "(?:foi|foram|e|era|sao|esta|estava|estao|ser|sera|seria|pode|podera|poderia|posso|podemos|pude|pudemos|" +
  "consigo|consegui|conseguimos|conseguiu|vai|vou|vamos|deve|devemos|precisa|ha|houve|tem|teve|" +
  "possivel|ainda|mais|o|a|os|as|seu|sua|seus|suas|pedido|pedidos|para|fazer|realizar|efetuar|como)";
const NEG_RIGHT_BEFORE = new RegExp(`\\b${NEG}(?:\\s+${AUX}){0,4}\\s*$`);
const NEG_INSIDE = /\b(nao|nunca|jamais)\b/;

/** Sentences; commas do not split, so "cancelamento, que ja foi concluido" stays together. */
function sentences(normalized: string): string[] {
  return normalized
    .split(/[.!?;\n]/)
    .flatMap((s) => s.split(/\b(?:mas|porem|entretanto)\b/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the text affirms that an order is cancelled (as opposed to asking or denying). */
export function claimsCancellation(text: string): boolean {
  const normalized = norm(text).replace(/[,()"'“”]/g, " ");
  return sentences(normalized).some((s) => {
    for (const m of s.matchAll(CANCEL_CLAIM)) {
      const negatedBefore = NEG_RIGHT_BEFORE.test(s.slice(0, m.index));
      const negatedInside = m[0].startsWith("cancelamento") && NEG_INSIDE.test(m[0]);
      if (!negatedBefore && !negatedInside) return true;
    }
    return false;
  });
}

const ORDER_NUMBER = /(?<![\d.,-])\d{4,10}(?!\d|[.,]\d)/g;

function orderNumbersIn(text: string): string[] {
  return text.match(ORDER_NUMBER) ?? [];
}

const PROMPT_MARKERS = [/<\/?\s*(fatos|mensagem_cliente|dados_externos)\s*>/i, /fatos\.cancelresult/i, /\b(understand|compose)\.v\d\b/i, /system\s*prompt/i];

function words(s: string): string[] {
  return norm(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const SHINGLE = 6;

function shingles(s: string): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(" "));
  return out;
}

const PROMPT_SHINGLES = new Set([...shingles(COMPOSE_SYSTEM_PROMPT_V1), ...shingles(UNDERSTAND_SYSTEM_PROMPT_V1)]);

/** True when the reply reproduces a run of six consecutive words from the system prompts. */
export function leaksPrompt(text: string): boolean {
  if (PROMPT_MARKERS.some((r) => r.test(text))) return true;
  for (const s of shingles(text)) if (PROMPT_SHINGLES.has(s)) return true;
  return false;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const PHONE = /\+?\d[\d\s().-]{8,}\d/;

const DEFAULT_PROTECTED = CUSTOMER_FIXTURES.flatMap((c) => [c.displayName, c.phoneE164]);

/** Identifiers of customers (ids, phones, e-mails, CPF, names) never belong in a reply. */
export function exposesCustomerData(text: string, protectedTerms: readonly string[] = DEFAULT_PROTECTED): boolean {
  if (UUID.test(text) || EMAIL.test(text) || CPF.test(text)) return true;
  const phone = text.match(PHONE);
  if (phone && phone[0].replace(/\D/g, "").length >= 10) return true;
  const n = norm(text);
  return protectedTerms.some((t) => t.length >= 4 && n.includes(norm(t)));
}

/** Order numbers the reply is allowed to mention: only those that are part of this conversation turn. */
function allowedOrderNumbers(state: AgentStateType): Set<string> {
  const ids = [state.orderId, state.order?.id, state.pendingAction?.orderId, ...(state.ambiguousOrders ?? [])];
  return new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0));
}

/**
 * Deterministic output guard (last defense layer). Code, not LLM. Validates the composed reply
 * against the graph state.
 */
export function checkOutput(reply: string, state: AgentStateType, protectedTerms?: readonly string[]): GuardResult {
  if (!reply || !reply.trim()) return { ok: false, rule: "EMPTY_REPLY" };
  if (reply.length > MAX_REPLY_CHARS) return { ok: false, rule: "REPLY_TOO_LONG" };

  if (leaksPrompt(reply)) return { ok: false, rule: "PROMPT_LEAK" };

  if (state.cancelResult !== "SUCCESS" && state.order?.status !== "CANCELLED" && claimsCancellation(reply)) {
    return { ok: false, rule: "CLAIMED_CANCEL_WITHOUT_SUCCESS" };
  }

  if (exposesCustomerData(reply, protectedTerms)) return { ok: false, rule: "OTHER_CUSTOMER_DATA" };

  const allowed = allowedOrderNumbers(state);
  if (orderNumbersIn(reply).some((n) => !allowed.has(n))) return { ok: false, rule: "WRONG_ORDER_NUMBER" };
  return { ok: true };
}

/** Safe template for a blocked reply, chosen from facts in the state only. */
export function pickFallback(state: AgentStateType): { name: string; text: string } {
  const orderId = state.order?.id ?? state.orderId ?? undefined;
  const status = state.order?.status;
  if (state.cancelResult === "SUCCESS" && orderId) return { name: "CANCEL_SUCCESS_TEMPLATE", text: templates.cancelSuccess(orderId) };
  if (state.cancelResult === "TECHNICAL_ERROR") return { name: "TECHNICAL_FAILURE_TEMPLATE", text: templates.technicalFailure() };
  if (state.cancelResult === "NOT_FOUND" || state.orderLookup === "NOT_FOUND") return { name: "NOT_FOUND_TEMPLATE", text: templates.notFound() };
  if (orderId && status === "CANCELLED") return { name: "ALREADY_CANCELLED_TEMPLATE", text: templates.alreadyCancelled(orderId) };
  if (orderId && status && (state.cancelResult === "NOT_CANCELLABLE" || status === "SHIPPED" || status === "DELIVERED")) {
    return { name: "NOT_CANCELLABLE_TEMPLATE", text: templates.notCancellableStatus(orderId, status) };
  }
  return { name: "SAFE_FALLBACK_TEMPLATE", text: templates.safeFallback() };
}
