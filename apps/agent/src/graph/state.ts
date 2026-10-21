import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { OrderView, ProductInfo, Understanding } from "@desafio/contracts";
import type { HandoffReason } from "../ports/index.js";
import type { CancelResult } from "../llm/types.js";

export const MAX_HISTORY_MESSAGES = 12;

export interface PendingAction {
  type: "CANCEL";
  orderId: string;
  /** Generated once with the pending action; reused by every retry of the cancel call. */
  idempotencyKey: string;
  /** ISO timestamp. After this instant a "SIM" no longer cancels anything (TC-19). */
  expiresAt: string;
}

export type InputRefusal = "EMPTY" | "TOO_LONG" | "FLOOD" | "UNKNOWN_CUSTOMER";
export type InputVerdict = { ok: true } | { ok: false; reason: InputRefusal };
export type ConfirmOutcome = "YES" | "NO" | "AMBIGUOUS" | "OTHER" | "EXPIRED";
export type OrderLookup = "OK" | "NOT_FOUND" | "TECHNICAL_ERROR";
export type ExternalStatus = "ok" | "degraded" | "unavailable";
export type AwaitedIntent = "CHECK_STATUS" | "CANCEL_ORDER";

/** Last-write-wins channel with a default. Optional fields use null (not undefined) so they can be reset. */
function lww<T>(def: T) {
  return Annotation<T>({ reducer: (_prev: T, next: T) => next, default: () => def });
}

/** LangGraph state. Turn scoped fields are reset by `turnReset()` at the start of each turn. */
export const AgentState = Annotation.Root({
  /** Short history (last N messages, PII redacted). */
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next].slice(-MAX_HISTORY_MESSAGES),
    default: () => [],
  }),

  // Channel / identity
  channel: lww<string>(""),
  threadId: lww<string>(""),
  traceId: lww<string>(""),
  /** Where the reply goes (channel address). Needed by `send`. */
  replyTo: lww<string>(""),
  inboundText: lww<string>(""),
  /** Internal id from the CustomerDirectoryPort, never the phone. Empty when unknown. */
  customerRef: lww<string>(""),

  // Understanding and routing
  inputVerdict: lww<InputVerdict | null>(null),
  understanding: lww<Understanding | null>(null),
  /** Target order of the current flow, validated against the message text. */
  orderId: lww<string | null>(null),
  ambiguousOrders: lww<string[] | null>(null),
  /** Intent that is waiting for an order number (survives between turns). */
  awaitingIntent: lww<AwaitedIntent | null>(null),
  clarifyAttempts: lww<number>(0),

  // Facts
  order: lww<OrderView | null>(null),
  orderLookup: lww<OrderLookup | null>(null),
  products: lww<ProductInfo[]>([]),
  externalStatus: lww<ExternalStatus>("ok"),

  // Confirmation
  pendingAction: lww<PendingAction | null>(null),
  confirmQuestion: lww<string | null>(null),
  confirmOutcome: lww<ConfirmOutcome | null>(null),
  confirmAttempts: lww<number>(0),
  /** Set when a previous confirmation expired and the question is being asked again. */
  confirmExpiredNotice: lww<boolean>(false),
  cancelResult: lww<CancelResult | null>(null),

  /** Named handoffInfo because a state channel cannot share its name with the `handoff` node. */
  handoffInfo: lww<{ reason: HandoffReason; ticketId: string } | null>(null),

  // Output
  /** Text produced by a template; compose does not call the LLM when present. */
  fixedReply: lww<string | null>(null),
  reply: lww<string | null>(null),
  guardBlock: lww<{ rule: string; fallback: string } | null>(null),
  crashed: lww<boolean>(false),
});

export type AgentStateType = typeof AgentState.State;
export type AgentUpdate = typeof AgentState.Update;

/** Resets everything that belongs to a single turn. Conversation level fields are kept. */
export function turnReset(): AgentUpdate {
  return {
    inputVerdict: null,
    understanding: null,
    orderId: null,
    ambiguousOrders: null,
    order: null,
    orderLookup: null,
    products: [],
    externalStatus: "ok",
    pendingAction: null,
    confirmQuestion: null,
    confirmOutcome: null,
    confirmAttempts: 0,
    confirmExpiredNotice: false,
    cancelResult: null,
    handoffInfo: null,
    fixedReply: null,
    reply: null,
    guardBlock: null,
    crashed: false,
  };
}
