import { describe, expect, it } from "vitest";
import { CancellationPolicy } from "../../src/domain/cancellation-policy.js";
import { makeOrder, ANA } from "../helpers/fixtures.js";

describe("CancellationPolicy", () => {
  const policy = new CancellationPolicy();

  it("allows cancelling a PROCESSING order", () => {
    expect(policy.evaluate(makeOrder("1042", ANA.id, "PROCESSING"))).toEqual({ cancellable: true });
  });

  it.each([
    ["SHIPPED", "ALREADY_SHIPPED"],
    ["DELIVERED", "ALREADY_DELIVERED"],
    ["CANCELLED", "ALREADY_CANCELLED"],
  ] as const)("rejects %s with reason %s", (status, reason) => {
    expect(policy.evaluate(makeOrder("1042", ANA.id, status))).toEqual({ cancellable: false, reason });
  });

  it("Order.isCancellable follows the policy for every status", () => {
    expect(makeOrder("1042", ANA.id, "PROCESSING").isCancellable()).toBe(true);
    expect(makeOrder("1042", ANA.id, "SHIPPED").isCancellable()).toBe(false);
    expect(makeOrder("1042", ANA.id, "DELIVERED").isCancellable()).toBe(false);
    expect(makeOrder("1042", ANA.id, "CANCELLED").isCancellable()).toBe(false);
  });
});
