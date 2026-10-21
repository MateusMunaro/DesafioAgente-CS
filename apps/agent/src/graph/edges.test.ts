import { describe, expect, it } from "vitest";
import type { Understanding } from "@desafio/contracts";
import {
  afterClarification,
  afterConfirm,
  afterEnrich,
  afterFetch,
  afterInputGuard,
  afterOutputGuard,
  afterPolicy,
  afterRoute,
  cancelAuthorized,
} from "./edges.js";
import type { PendingAction } from "./state.js";
import { ManualClock, baseState, minutes, order } from "./testing.js";

const u = (intent: Understanding["intent"]): Understanding => ({ intent, orderId: null, confidence: 0.9 });
const pending = (clock: ManualClock, ttl = minutes(10), orderId = "1042"): PendingAction => ({
  type: "CANCEL",
  orderId,
  idempotencyKey: "k1",
  expiresAt: new Date(clock.now().getTime() + ttl).toISOString(),
});

describe("conditional edges (one test per branch of the flowchart)", () => {
  it("input_guard: ok -> understand; blocked -> refuse; crash -> handoff", () => {
    expect(afterInputGuard(baseState({ inputVerdict: { ok: true } }))).toBe("understand");
    for (const reason of ["EMPTY", "TOO_LONG", "FLOOD", "UNKNOWN_CUSTOMER"] as const) {
      expect(afterInputGuard(baseState({ inputVerdict: { ok: false, reason } }))).toBe("refuse");
    }
    expect(afterInputGuard(baseState({ crashed: true }))).toBe("handoff");
  });

  describe("route", () => {
    it.each([
      ["RULE_OVERRIDE_ATTEMPT", "refuse"],
      ["HUMAN_REQUEST", "handoff"],
      ["OUT_OF_SCOPE", "handoff"],
      ["GREETING", "compose"],
      ["PRODUCT_QUESTION", "compose"],
      ["UNCLEAR", "ask_clarification"],
    ] as const)("%s -> %s", (intent, next) => {
      expect(afterRoute(baseState({ understanding: u(intent) }))).toBe(next);
    });
    it.each(["CHECK_STATUS", "CANCEL_ORDER"] as const)("%s without orderId -> ask_clarification", (intent) => {
      expect(afterRoute(baseState({ understanding: u(intent), orderId: null }))).toBe("ask_clarification");
    });
    it.each(["CHECK_STATUS", "CANCEL_ORDER"] as const)("%s with orderId -> fetch_order", (intent) => {
      expect(afterRoute(baseState({ understanding: u(intent), orderId: "1042" }))).toBe("fetch_order");
    });
    it("two orders in one message -> ask_clarification", () => {
      expect(afterRoute(baseState({ understanding: u("CANCEL_ORDER"), orderId: "1042", ambiguousOrders: ["1042", "1043"] }))).toBe("ask_clarification");
    });
    it("crash -> handoff", () => expect(afterRoute(baseState({ crashed: true, understanding: u("GREETING") }))).toBe("handoff"));
  });

  it("ask_clarification: up to 2 attempts wait for the customer, the 3rd hands off", () => {
    expect(afterClarification(baseState({ clarifyAttempts: 1 }))).toBe("send");
    expect(afterClarification(baseState({ clarifyAttempts: 2 }))).toBe("send");
    expect(afterClarification(baseState({ clarifyAttempts: 3 }))).toBe("handoff");
  });

  it("fetch_order: 200 -> enrich_products; 404 or technical error -> compose", () => {
    expect(afterFetch(baseState({ orderLookup: "OK", order: order("PROCESSING") }))).toBe("enrich_products");
    expect(afterFetch(baseState({ orderLookup: "NOT_FOUND" }))).toBe("compose");
    expect(afterFetch(baseState({ orderLookup: "TECHNICAL_ERROR" }))).toBe("compose");
  });

  it("intent split: STATUS -> compose; CANCEL -> policy_check", () => {
    expect(afterEnrich(baseState({ understanding: u("CHECK_STATUS") }))).toBe("compose");
    expect(afterEnrich(baseState({ understanding: u("CANCEL_ORDER") }))).toBe("policy_check");
  });

  it("policy_check: only PROCESSING (with a pendingAction) proceeds to confirm", () => {
    const clock = new ManualClock();
    expect(afterPolicy(baseState({ order: order("PROCESSING"), pendingAction: pending(clock) }))).toBe("confirm");
    for (const s of ["SHIPPED", "DELIVERED", "CANCELLED"] as const) {
      expect(afterPolicy(baseState({ order: order(s), pendingAction: null }))).toBe("compose");
      // even a stray pendingAction cannot move a non PROCESSING order forward
      expect(afterPolicy(baseState({ order: order(s), pendingAction: pending(clock) }))).toBe("compose");
    }
  });

  describe("confirm", () => {
    const clock = new ManualClock();
    const edge = afterConfirm(clock);
    const withOutcome = (confirmOutcome: "YES" | "NO" | "AMBIGUOUS" | "OTHER" | "EXPIRED", extra = {}) =>
      baseState({ confirmOutcome, order: order("PROCESSING"), pendingAction: pending(clock), ...extra });

    it("YES with a valid pendingAction -> execute_cancel", () => expect(edge(withOutcome("YES"))).toBe("execute_cancel"));
    it("NO -> compose", () => expect(edge(withOutcome("NO"))).toBe("compose"));
    it("AMBIGUOUS -> confirm again", () => expect(edge(withOutcome("AMBIGUOUS"))).toBe("confirm"));
    it("another message -> understand", () => expect(edge(withOutcome("OTHER"))).toBe("understand"));
    it("expired -> fetch_order (ask again with fresh data)", () => expect(edge(withOutcome("EXPIRED"))).toBe("fetch_order"));

    it("YES without a pendingAction never reaches execute_cancel", () => {
      expect(edge(withOutcome("YES", { pendingAction: null }))).toBe("fallback");
    });
    it("YES with an expired pendingAction never reaches execute_cancel", () => {
      expect(edge(withOutcome("YES", { pendingAction: pending(clock, -1) }))).toBe("fallback");
    });
    it("YES for another order never reaches execute_cancel", () => {
      expect(edge(withOutcome("YES", { pendingAction: pending(clock, minutes(10), "1043") }))).toBe("fallback");
    });
    it("no outcome (null) never reaches execute_cancel", () => {
      expect(edge(baseState({ order: order("PROCESSING"), pendingAction: pending(clock) }))).not.toBe("execute_cancel");
    });
    it("cancelAuthorized is true only for YES + valid action", () => {
      expect(cancelAuthorized(withOutcome("YES"), clock)).toBe(true);
      for (const o of ["NO", "AMBIGUOUS", "OTHER", "EXPIRED"] as const) expect(cancelAuthorized(withOutcome(o), clock)).toBe(false);
    });
  });

  it("output_guard: approved -> send; blocked -> fallback", () => {
    expect(afterOutputGuard(baseState({ guardBlock: null }))).toBe("send");
    expect(afterOutputGuard(baseState({ guardBlock: { rule: "X", fallback: "Y" } }))).toBe("fallback");
  });
});
