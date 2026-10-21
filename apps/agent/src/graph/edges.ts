import { MAX_CLARIFY_ATTEMPTS, type Clock } from "./deps.js";
import type { AgentStateType } from "./state.js";

/**
 * Conditional edges of the support graph. Pure functions of the state:
 * decisions are made here, in code, never by the LLM.
 * Any node that crashed unexpectedly routes to `handoff` (technical failure, nothing is claimed).
 */

export type AfterInputGuard = "understand" | "refuse" | "handoff";
export function afterInputGuard(s: AgentStateType): AfterInputGuard {
  if (s.crashed) return "handoff";
  return s.inputVerdict?.ok === true ? "understand" : "refuse";
}

export type AfterRoute = "refuse" | "handoff" | "compose" | "ask_clarification" | "fetch_order";
export function afterRoute(s: AgentStateType): AfterRoute {
  if (s.crashed) return "handoff";
  switch (s.understanding?.intent) {
    case "RULE_OVERRIDE_ATTEMPT":
      return "refuse";
    case "HUMAN_REQUEST":
    case "OUT_OF_SCOPE":
      return "handoff";
    case "GREETING":
    case "PRODUCT_QUESTION":
      return "compose";
    case "CHECK_STATUS":
    case "CANCEL_ORDER":
      // Two orders in one message: ask which one, one at a time (S8).
      if ((s.ambiguousOrders?.length ?? 0) > 1 || !s.orderId) return "ask_clarification";
      return "fetch_order";
    default:
      return "ask_clarification";
  }
}

export type AfterClarification = "handoff" | "send";
export function afterClarification(s: AgentStateType): AfterClarification {
  if (s.crashed || s.clarifyAttempts > MAX_CLARIFY_ATTEMPTS) return "handoff";
  return "send";
}

export type AfterFetch = "enrich_products" | "compose" | "handoff";
export function afterFetch(s: AgentStateType): AfterFetch {
  if (s.crashed) return "handoff";
  return s.orderLookup === "OK" && s.order ? "enrich_products" : "compose";
}

export type AfterEnrich = "policy_check" | "compose" | "handoff";
export function afterEnrich(s: AgentStateType): AfterEnrich {
  if (s.crashed) return "handoff";
  return s.understanding?.intent === "CANCEL_ORDER" ? "policy_check" : "compose";
}

export type AfterPolicy = "confirm" | "compose" | "handoff";
/** Only PROCESSING orders (those that got a pendingAction) proceed to confirmation. */
export function afterPolicy(s: AgentStateType): AfterPolicy {
  if (s.crashed) return "handoff";
  return s.order?.status === "PROCESSING" && s.pendingAction ? "confirm" : "compose";
}

export type AfterConfirm = "execute_cancel" | "confirm" | "understand" | "fetch_order" | "compose" | "fallback";

/** True only for an explicit YES tied to a valid, non-expired pending action for the loaded order. */
export function cancelAuthorized(s: AgentStateType, clock: Clock): boolean {
  const p = s.pendingAction;
  return (
    s.confirmOutcome === "YES" &&
    p !== null &&
    p.type === "CANCEL" &&
    s.order?.id === p.orderId &&
    clock.now().getTime() < Date.parse(p.expiresAt)
  );
}

export function afterConfirm(clock: Clock) {
  return (s: AgentStateType): AfterConfirm => {
    switch (s.confirmOutcome) {
      case "YES":
        return cancelAuthorized(s, clock) ? "execute_cancel" : "fallback";
      case "AMBIGUOUS":
        return "confirm";
      case "OTHER":
        return "understand";
      case "EXPIRED":
        return "fetch_order";
      default:
        return "compose";
    }
  };
}

export type AfterOutputGuard = "send" | "fallback";
export function afterOutputGuard(s: AgentStateType): AfterOutputGuard {
  return s.guardBlock ? "fallback" : "send";
}
