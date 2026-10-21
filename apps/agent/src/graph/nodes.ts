import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import type { OrderView } from "@desafio/contracts";
import { redactPii } from "../adapters/handoff/redact.js";
import { sanitizeText } from "../adapters/fakestore/sanitize.js";
import { extractOrderIds } from "../llm/fake.js";
import type { ComposeFacts } from "../llm/types.js";
import { PROMPT_VERSIONS } from "../prompts/index.js";
import type { HandoffReason } from "../ports/index.js";
import { DEFAULT_CONFIRMATION_TTL_MS, MAX_AMBIGUOUS_CONFIRMATIONS, MAX_CLARIFY_ATTEMPTS, type GraphDeps } from "./deps.js";
import { parseConfirmation } from "./confirmation.js";
import { checkInput, checkOutput, pickFallback } from "./guards.js";
import { graphReplies, inputRefusalText, templates } from "./replies.js";
import { turnReset, type AgentStateType, type AgentUpdate } from "./state.js";

/** Payload of the confirmation interrupt. The runtime sends `question` to the customer. */
export interface ConfirmInterruptPayload {
  type: "CONFIRM_CANCEL";
  question: string;
  orderId: string;
  expiresAt: string;
}

type NodeFn = (state: AgentStateType) => Promise<AgentUpdate>;

export function createNodes(deps: GraphDeps) {
  const log = deps.logger;
  const ttl = deps.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;

  const ctx = (s: AgentStateType) => ({ traceId: s.traceId, thread: s.threadId });

  /** Unexpected exceptions never reach the customer: they become a technical-failure handoff. */
  const safe =
    (name: string, fn: NodeFn): NodeFn =>
    async (state) => {
      try {
        return await fn(state);
      } catch (err) {
        if (isGraphBubbleUp(err)) throw err;
        log.error({ event: "agent.node.failed", node: name, error: err instanceof Error ? err.name : "UNKNOWN", ...ctx(state) });
        return { crashed: true };
      }
    };

  /** Opens a ticket; never throws. A ticket that could not be stored still hands the customer over. */
  async function openHandoff(state: AgentStateType, reason: HandoffReason, summary: string) {
    try {
      const ticket = await deps.handoff.open(state.threadId, reason, summary);
      log.info({ event: "agent.handoff.opened", reason, ticketStatus: ticket.status, ...ctx(state) });
      return { reason, ticketId: ticket.id };
    } catch (err) {
      log.error({ event: "agent.handoff.failed", reason, error: err instanceof Error ? err.name : "UNKNOWN", ...ctx(state) });
      return { reason, ticketId: "UNPERSISTED" };
    }
  }

  /** Item names for replies: only when the Fake Store answered completely (degraded means no product names). */
  function itemsFor(state: AgentStateType): Array<{ name: string; quantity: number }> {
    const order = state.order;
    if (!order || state.externalStatus !== "ok") return [];
    const byId = new Map(state.products.map((p) => [p.id, p]));
    return order.items.map((i) => ({
      name: sanitizeText(byId.get(i.productExternalId)?.title ?? i.productTitle, 80),
      quantity: i.quantity,
    }));
  }

  // ------------------------------------------------------------------ nodes

  const ingest = safe("ingest", async (state) => {
    const lookup = await deps.customers.resolveByPhone(state.replyTo);
    return {
      ...turnReset(),
      customerRef: lookup.kind === "FOUND" ? lookup.customerRef : "",
      messages: [new HumanMessage(redactPii(state.inboundText))],
    };
  });

  const input_guard = safe("input_guard", async (state) => {
    const flooding = !deps.rateLimiter.hit(state.threadId);
    let verdict = checkInput(state.inboundText, flooding);
    if (verdict.ok && !state.customerRef) verdict = { ok: false, reason: "UNKNOWN_CUSTOMER" };
    if (!verdict.ok) log.info({ event: "agent.input_guard.blocked", reason: verdict.reason, inputChars: state.inboundText.length, ...ctx(state) });
    return { inputVerdict: verdict };
  });

  const understand = safe("understand", async (state) => {
    const text = state.inboundText;
    // History is everything before the current message (the last message is the current one).
    const history = state.messages.slice(0, -1).map((m) => String(m.content));
    const started = performance.now();
    const raw = await deps.classifier.classify(text, history);
    const ids = extractOrderIds(text);
    // The model may not invent order numbers: only numbers literally present in the message count.
    const orderId = raw.orderId && ids.includes(raw.orderId) ? raw.orderId : null;
    log.info({
      event: "agent.intent.classified",
      intent: raw.intent,
      confidence: raw.confidence,
      hasOrderId: orderId !== null,
      promptVersion: PROMPT_VERSIONS.understand,
      latencyMs: Math.round(performance.now() - started),
      inputChars: text.length,
      ...ctx(state),
    });
    return {
      understanding: { ...raw, orderId },
      orderId,
      ambiguousOrders: ids.length > 1 ? ids.slice(0, 2) : null,
    };
  });

  /** Applies the "waiting for an order number" context, then edges.afterRoute picks the branch. */
  const route = safe("route", async (state) => {
    const u = state.understanding;
    if (!u) return { crashed: true };
    const awaiting = state.awaitingIntent;
    const bareReply = state.inboundText.length <= 30;
    if (awaiting && state.orderId && (u.intent === "CHECK_STATUS" || u.intent === "UNCLEAR") && bareReply) {
      return { understanding: { ...u, intent: awaiting } };
    }
    return {};
  });

  const ask_clarification = safe("ask_clarification", async (state) => {
    const attempts = state.clarifyAttempts + 1;
    const intent = state.understanding?.intent;
    const awaiting = intent === "CHECK_STATUS" || intent === "CANCEL_ORDER" ? intent : state.awaitingIntent;
    if (attempts > MAX_CLARIFY_ATTEMPTS) return { clarifyAttempts: attempts };
    const amb = state.ambiguousOrders;
    const reply =
      amb && amb.length > 1 ? templates.askWhichOrder(amb[0] as string, amb[1] as string) : awaiting ? templates.askOrderId() : graphReplies.clarify();
    log.info({ event: "agent.clarification.asked", attempt: attempts, ...ctx(state) });
    return { clarifyAttempts: attempts, awaitingIntent: awaiting, reply };
  });

  const fetch_order = safe("fetch_order", async (state) => {
    const orderId = state.orderId;
    const progress = { clarifyAttempts: 0, awaitingIntent: null } as const;
    if (!orderId) return { ...progress, orderLookup: "NOT_FOUND", fixedReply: templates.notFound() };
    let result;
    try {
      result = await deps.orderApi.getOrder(state.customerRef, orderId, { traceId: state.traceId });
    } catch {
      result = { kind: "TECHNICAL_ERROR" as const, cause: "NETWORK" as const, attempts: 1 };
    }
    log.info({ event: "agent.order.fetched", result: result.kind, ...ctx(state) });
    if (result.kind === "OK" && result.data.id === orderId) return { ...progress, order: result.data, orderLookup: "OK" };
    if (result.kind === "TECHNICAL_ERROR") {
      const handoff = await openHandoff(state, "API_FAILURE", `Falha tecnica ao consultar o pedido ${orderId}`);
      return { ...progress, orderLookup: "TECHNICAL_ERROR", handoffInfo: handoff, fixedReply: graphReplies.technicalHandoff() };
    }
    // 404 (also for orders of other customers), validation errors and mismatches look the same to the customer (TC-12).
    return { ...progress, orderLookup: "NOT_FOUND", fixedReply: templates.notFound() };
  });

  const enrich_products = safe("enrich_products", async (state) => {
    const order = state.order;
    if (!order) return {};
    const ids = [...new Set(order.items.map((i) => i.productExternalId))];
    try {
      const lookup = await deps.catalog.getProducts(ids, { traceId: state.traceId });
      if (lookup.status !== "ok") log.warn({ event: "agent.enrich_products.degraded", status: lookup.status, ...ctx(state) });
      return { products: lookup.products, externalStatus: lookup.status };
    } catch (err) {
      log.warn({ event: "agent.enrich_products.failed", error: err instanceof Error ? err.name : "UNKNOWN", ...ctx(state) });
      return { products: [], externalStatus: "unavailable" };
    }
  });

  const policy_check = safe("policy_check", async (state) => {
    const order = state.order as OrderView;
    const cancellable = order.status === "PROCESSING";
    log.info({ event: "agent.policy.checked", status: order.status, cancellable, ...ctx(state) });
    if (!cancellable) {
      return {
        cancelResult: "NOT_CANCELLABLE",
        ...(order.status === "CANCELLED" ? { fixedReply: templates.alreadyCancelled(order.id) } : {}),
      };
    }
    const now = deps.clock.now().getTime();
    const pendingAction = {
      type: "CANCEL" as const,
      orderId: order.id,
      idempotencyKey: deps.ids.uuid(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    let question = templates.cancelConfirmation(order.id, itemsFor(state));
    // Item names come from an external system: the question goes through the same output guard.
    if (!checkOutput(question, { ...state, pendingAction }, deps.protectedTerms).ok) question = templates.cancelConfirmation(order.id, []);
    if (state.confirmExpiredNotice) question = `${graphReplies.confirmationExpired()} ${question}`;
    return { pendingAction, confirmQuestion: question, confirmOutcome: null, confirmAttempts: 0, messages: [new AIMessage(redactPii(question))] };
  });

  /**
   * Pauses the graph (interrupt) until the customer answers. On resume the whole node runs again and
   * interrupt() returns the answer. Everything before interrupt() must stay free of side effects.
   */
  const confirm = async (state: AgentStateType): Promise<AgentUpdate> => {
    const pending = state.pendingAction;
    if (!pending) return { confirmOutcome: "NO", fixedReply: templates.safeFallback() };
    const question =
      state.confirmOutcome === "AMBIGUOUS" ? templates.confirmationAmbiguous() : (state.confirmQuestion ?? templates.cancelConfirmation(pending.orderId, []));
    const payload: ConfirmInterruptPayload = { type: "CONFIRM_CANCEL", question, orderId: pending.orderId, expiresAt: pending.expiresAt };
    const answer: unknown = interrupt(payload);

    const text = typeof answer === "string" ? answer : "";
    const parsed = parseConfirmation(text, pending.orderId);
    const expired = deps.clock.now().getTime() >= Date.parse(pending.expiresAt);
    const heard = { inboundText: text, messages: [new HumanMessage(redactPii(text))] };
    log.info({ event: "agent.confirm.answered", parsed, expired, inputChars: text.length, ...ctx(state) });

    if (parsed === "OTHER") {
      // A different message: the pending action is discarded and the message is understood from scratch.
      return { ...turnReset(), ...heard, confirmOutcome: "OTHER" };
    }
    if (parsed === "NO") {
      return { ...heard, pendingAction: null, confirmOutcome: "NO", fixedReply: templates.cancelNotConfirmed(pending.orderId) };
    }
    if (expired) {
      return { ...heard, pendingAction: null, confirmOutcome: "EXPIRED", confirmExpiredNotice: true };
    }
    if (parsed === "AMBIGUOUS") {
      const attempts = state.confirmAttempts + 1;
      if (attempts > MAX_AMBIGUOUS_CONFIRMATIONS) {
        return { ...heard, pendingAction: null, confirmOutcome: "NO", confirmAttempts: attempts, fixedReply: graphReplies.confirmationDropped(pending.orderId) };
      }
      return { ...heard, confirmOutcome: "AMBIGUOUS", confirmAttempts: attempts };
    }
    return { ...heard, confirmOutcome: "YES" };
  };

  const execute_cancel = safe("execute_cancel", async (state) => {
    const pending = state.pendingAction;
    const order = state.order;
    const notExpired = pending !== null && deps.clock.now().getTime() < Date.parse(pending.expiresAt);
    // Defense in depth: the edge already checked this, the node refuses to act otherwise.
    if (state.confirmOutcome !== "YES" || !pending || !notExpired || !order || pending.orderId !== order.id) {
      log.error({ event: "agent.execute_cancel.refused", ...ctx(state) });
      return { pendingAction: null, fixedReply: templates.safeFallback() };
    }
    let result;
    try {
      result = await deps.orderApi.cancel(state.customerRef, pending.orderId, pending.idempotencyKey, { traceId: state.traceId });
    } catch {
      result = { kind: "TECHNICAL_ERROR" as const, cause: "NETWORK" as const, attempts: 1 };
    }
    log.info({ event: "agent.cancel.executed", result: result.kind, ...ctx(state) });
    switch (result.kind) {
      case "OK":
        return { pendingAction: null, cancelResult: "SUCCESS", order: { ...order, status: "CANCELLED" } };
      case "NOT_CANCELLABLE":
        return { pendingAction: null, cancelResult: "NOT_CANCELLABLE", order: { ...order, status: result.currentStatus } };
      case "NOT_FOUND":
        return { pendingAction: null, cancelResult: "NOT_FOUND", fixedReply: templates.notFound() };
      default: {
        // Unknown outcome: never claim anything, hand over to a human.
        const handoff = await openHandoff(state, "API_FAILURE", `Falha tecnica ao cancelar o pedido ${pending.orderId}`);
        return { pendingAction: null, cancelResult: "TECHNICAL_ERROR", handoffInfo: handoff, fixedReply: graphReplies.technicalHandoff() };
      }
    }
  });

  const handoff = safe("handoff", async (state) => {
    const intent = state.understanding?.intent;
    const tooUnclear = state.clarifyAttempts > MAX_CLARIFY_ATTEMPTS;
    const reason: HandoffReason = state.crashed
      ? "API_FAILURE"
      : tooUnclear
        ? "AMBIGUITY"
        : intent === "HUMAN_REQUEST"
          ? "USER_REQUEST"
          : "OUT_OF_SCOPE";
    const ticket = await openHandoff(state, reason, `Intent ${intent ?? "n/a"}; pedido ${state.orderId ?? "n/a"}; motivo ${reason}`);
    const fixedReply = state.crashed ? graphReplies.technicalHandoff() : tooUnclear ? templates.clarificationLimit() : null;
    return { handoffInfo: ticket, fixedReply, crashed: false, clarifyAttempts: 0, awaitingIntent: null };
  });

  const compose = async (state: AgentStateType): Promise<AgentUpdate> => {
    if (state.fixedReply) return { reply: state.fixedReply };
    // Refusals do not call the LLM (D7): the offer of a human is part of the fixed text.
    if (state.cancelResult === "NOT_CANCELLABLE" && state.order && (state.order.status === "SHIPPED" || state.order.status === "DELIVERED")) {
      return { reply: templates.notCancellableStatus(state.order.id, state.order.status) };
    }
    const intent = state.understanding?.intent;
    const facts: ComposeFacts = {
      ...(intent ? { intent } : {}),
      ...(state.order ? { orderId: state.order.id, orderStatus: state.order.status, items: itemsFor(state) } : {}),
      ...(state.cancelResult ? { cancelResult: state.cancelResult } : {}),
      ...(state.externalStatus !== "ok" ? { degraded: true } : {}),
      ...(state.handoffInfo ? { handoff: templates.handoff() } : {}),
      ...(!state.order && intent === "PRODUCT_QUESTION"
        ? { note: "Posso informar sobre os itens de um pedido. Me diga o numero do pedido." }
        : {}),
      ...(state.handoffInfo && !state.order ? { note: "Esse assunto precisa de um atendente humano." } : {}),
    };
    let reply: string;
    try {
      reply = await deps.composer.compose(facts);
    } catch {
      reply = templates.safeFallback();
    }
    if (state.handoffInfo && !/atendente/i.test(reply)) reply = `${reply} ${templates.handoff()}`;
    return { reply };
  };

  const output_guard = async (state: AgentStateType): Promise<AgentUpdate> => {
    const result = checkOutput(state.reply ?? "", state, deps.protectedTerms);
    if (result.ok) return { guardBlock: null };
    const fallback = pickFallback(state).name;
    log.warn({ event: "agent.output_guard.blocked", rule: result.rule, fallback, ...ctx(state) });
    return { guardBlock: { rule: result.rule, fallback } };
  };

  const fallback = async (state: AgentStateType): Promise<AgentUpdate> => ({ reply: pickFallback(state).text });

  const refuse = async (state: AgentStateType): Promise<AgentUpdate> => {
    const v = state.inputVerdict;
    const reply = v && !v.ok ? inputRefusalText(v.reason) : templates.ruleOverrideRefusal();
    log.info({ event: "agent.refused", cause: v && !v.ok ? v.reason : "RULE_OVERRIDE_ATTEMPT", ...ctx(state) });
    return { reply };
  };

  const send = async (state: AgentStateType): Promise<AgentUpdate> => {
    const reply = state.reply && state.reply.trim() ? state.reply : templates.safeFallback();
    try {
      const res = await deps.messaging.send(state.replyTo, reply);
      if (res.kind === "FAILED") log.error({ event: "agent.send.failed", reason: res.reason, ...ctx(state) });
    } catch (err) {
      log.error({ event: "agent.send.failed", reason: err instanceof Error ? err.name : "UNKNOWN", ...ctx(state) });
    }
    return { reply, messages: [new AIMessage(redactPii(reply))] };
  };

  return {
    ingest,
    input_guard,
    understand,
    route,
    ask_clarification,
    fetch_order,
    enrich_products,
    policy_check,
    confirm,
    execute_cancel,
    handoff,
    compose,
    output_guard,
    fallback,
    refuse,
    send,
  };
}

export type GraphNodes = ReturnType<typeof createNodes>;
