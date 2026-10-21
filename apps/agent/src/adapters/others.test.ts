import { CUSTOMER_FIXTURES } from "@desafio/contracts";
import { describe, expect, it } from "vitest";
import { StaticCustomerDirectory } from "./customers/staticCustomerDirectory.js";
import { InMemoryHandoffService } from "./handoff/inMemoryHandoffService.js";
import { INSERT_HANDOFF_SQL, PgHandoffService } from "./handoff/pgHandoffService.js";
import { redactPii } from "./handoff/redact.js";
import { MockMessagingGateway } from "./messaging/mockMessagingGateway.js";
import { captureLogger } from "./testUtils.js";

describe("MockMessagingGateway", () => {
  it("stores messages in the outbox and logs size only (no phone, no text)", async () => {
    const log = captureLogger();
    const gw = new MockMessagingGateway({ logger: log.logger });
    const r = await gw.send("+5511999990001", "Seu pedido 1042 foi cancelado");
    expect(r.kind).toBe("SENT");
    expect(gw.outbox).toHaveLength(1);
    expect(gw.sentTo("+5511999990001")[0]?.text).toContain("1042");
    expect(log.raw()).not.toContain("5511999990001");
    expect(log.raw()).not.toContain("cancelado");
    expect(log.lines()[0]).toMatchObject({ event: "messaging.sent", textChars: 29 });
  });

  it("rejects empty text without throwing", async () => {
    const gw = new MockMessagingGateway({ logger: captureLogger().logger });
    expect(await gw.send("+5511999990001", "  ")).toEqual({ kind: "FAILED", reason: "EMPTY_RECIPIENT_OR_TEXT" });
    expect(gw.outbox).toHaveLength(0);
  });
});

describe("StaticCustomerDirectory", () => {
  it("resolves fixture phones to the customer id", async () => {
    const dir = new StaticCustomerDirectory();
    const c = CUSTOMER_FIXTURES[0]!;
    expect(await dir.resolveByPhone(c.phoneE164)).toEqual({ kind: "FOUND", customerRef: c.id });
  });
  it("unknown or malformed phone -> NOT_FOUND", async () => {
    const dir = new StaticCustomerDirectory();
    expect(await dir.resolveByPhone("+5500000000000")).toEqual({ kind: "NOT_FOUND" });
    expect(await dir.resolveByPhone("11999990001")).toEqual({ kind: "NOT_FOUND" });
  });
});

describe("redactPii", () => {
  it("masks e-mail, CPF and phone but keeps order ids", () => {
    const out = redactPii("Cliente ana@x.com.br CPF 123.456.789-09 tel +55 11 99999-0001 pedido 1042 e 1043");
    expect(out).toBe("Cliente [email] CPF [cpf] tel [phone] pedido 1042 e 1043");
  });
});

describe("InMemoryHandoffService", () => {
  it("opens a redacted ticket and logs without the summary", async () => {
    const log = captureLogger();
    const svc = new InMemoryHandoffService({ logger: log.logger });
    const t = await svc.open("wa:abc", "API_FAILURE", "Falha ao cancelar. Contato ana@x.com");
    expect(t).toMatchObject({ conversationId: "wa:abc", reason: "API_FAILURE", status: "OPEN", summary: "Falha ao cancelar. Contato [email]" });
    expect(svc.tickets).toHaveLength(1);
    expect(log.raw()).not.toContain("Falha ao cancelar");
  });
});

describe("PgHandoffService", () => {
  it("inserts into agent.handoff_tickets with redacted summary", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const created = new Date("2026-10-19T12:00:00Z");
    const svc = new PgHandoffService(
      { query: async (text, values) => (calls.push({ text, values }), { rows: [{ created_at: created }] }) },
      { logger: captureLogger().logger },
    );
    const t = await svc.open("wa:abc", "USER_REQUEST", "Pediu humano, tel +5511999990001");
    expect(calls[0]?.text).toBe(INSERT_HANDOFF_SQL);
    expect(calls[0]?.text).toContain("agent.handoff_tickets");
    expect(calls[0]?.values.slice(1)).toEqual(["wa:abc", "USER_REQUEST", "Pediu humano, tel [phone]"]);
    expect(t).toMatchObject({ status: "OPEN", createdAt: created.toISOString(), id: calls[0]?.values[0] });
  });

  it("database failure never throws: returns an UNPERSISTED ticket and logs the failure", async () => {
    const log = captureLogger();
    const svc = new PgHandoffService({ query: async () => Promise.reject(new Error("connection refused 10.0.0.1")) }, { logger: log.logger });
    const t = await svc.open("wa:abc", "API_FAILURE", "x");
    expect(t.status).toBe("UNPERSISTED");
    expect(log.lines().some((l) => l.event === "handoff.persist_failed")).toBe(true);
    expect(log.raw()).not.toContain("10.0.0.1");
  });
});
