import { describe, expect, it } from "vitest";
import { templates } from "./index.js";

describe("templates", () => {
  it("cancel confirmation cites number and items", () => {
    const t = templates.cancelConfirmation("1234", [{ name: "Camiseta", quantity: 2 }, { name: "Bone" }]);
    expect(t).toContain("1234");
    expect(t).toContain("2x Camiseta");
    expect(t).toContain("Bone");
    expect(t).toContain("SIM");
  });
  it("all templates are non-empty and never claim cancellation by accident", () => {
    const all = [
      templates.ruleOverrideRefusal(),
      templates.notCancellableStatus("1234", "SHIPPED"),
      templates.alreadyCancelled("1234"),
      templates.notFound(),
      templates.technicalFailure(),
      templates.handoff(),
      templates.safeFallback(),
      templates.clarificationLimit(),
      templates.confirmationAmbiguous(),
      templates.askOrderId(),
      templates.askWhichOrder("1111", "2222"),
    ];
    for (const t of all) expect(t.length).toBeGreaterThan(10);
    expect(templates.notCancellableStatus("1234", "SHIPPED")).toContain("SHIPPED");
    expect(templates.technicalFailure()).not.toMatch(/foi cancelado/);
    expect(templates.ruleOverrideRefusal()).not.toMatch(/prompt|instrucoes internas/);
  });
});
