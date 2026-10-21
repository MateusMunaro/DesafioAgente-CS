import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/infra/logger.js";
import { captureLogs } from "../helpers/fixtures.js";

describe("logger redaction", () => {
  it("censors phone, name, authorization and body at the top level and nested", () => {
    const logs = captureLogs();
    const log = createLogger({ level: "info", destination: logs.stream });
    log.info({
      event: "test.redaction",
      phone: "+5511999990001",
      displayName: "Ana Souza",
      authorization: "Bearer abc",
      body: { text: "hello" },
      req: { headers: { authorization: "Bearer abc", "x-customer-ref": "11111111-1111-4111-8111-111111111111" }, body: "x" },
      customer: { phone_e164: "+5511999990001", name: "Ana Souza" },
    });
    const raw = logs.raw();
    for (const secret of ["+5511999990001", "Ana Souza", "Bearer abc", "hello", "11111111-1111"]) expect(raw).not.toContain(secret);
    expect(logs.entries()[0]).toMatchObject({ level: "info", service: "order-api", event: "test.redaction", phone: "[REDACTED]" });
  });
});
