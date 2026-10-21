import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli.js";
import { ANA, BRUNO, ManualClock, harness } from "../graph/testing.js";
import { createApp } from "../http/app.js";
import { AGENT_MIGRATIONS_DIR } from "../persistence/migrate.js";
import {
  INSERT_MESSAGE_SQL,
  PgConversationStore,
  UPSERT_CONVERSATION_SQL,
  type Queryable,
} from "../persistence/conversationStore.js";
import { createOfflineContainer, createTestContainer } from "./container.js";
import { loadConfig } from "./config.js";
import { InMemoryOrderApi } from "./offline.js";
import { SlidingWindowRateLimiter } from "./rateLimiter.js";
import { threadIdFor } from "./threadId.js";
import { templates } from "../templates/index.js";
import path from "node:path";

describe("SlidingWindowRateLimiter", () => {
  it("allows `max` hits per window and key, then blocks until the window passes", () => {
    const clock = new ManualClock();
    const rl = new SlidingWindowRateLimiter({ max: 2, windowMs: 1000, clock });
    expect([rl.hit("a"), rl.hit("a"), rl.hit("a")]).toEqual([true, true, false]);
    expect(rl.hit("b")).toBe(true);
    clock.advance(1001);
    expect(rl.hit("a")).toBe(true);
  });
});

describe("threadIdFor", () => {
  it("is stable, channel scoped and hides the phone", () => {
    expect(threadIdFor("wa", ANA.phoneE164)).toBe(threadIdFor("wa", ANA.phoneE164));
    expect(threadIdFor("wa", ANA.phoneE164)).not.toBe(threadIdFor("wa", BRUNO.phoneE164));
    expect(threadIdFor("wa", ANA.phoneE164)).toMatch(/^wa:[0-9a-f]{16}$/);
  });
});

describe("HTTP server (POST /webhook/messages, GET /health)", () => {
  const appFor = () => {
    const h = harness();
    return { h, app: createApp({ runtime: h.container.runtime, logger: h.container.deps.logger }) };
  };

  it("GET /health", async () => {
    const res = await request(appFor().app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "agent" });
  });

  it("POST /webhook/messages answers a status question", async () => {
    const { app, h } = appFor();
    const res = await request(app).post("/webhook/messages").send({ from: ANA.phoneE164, text: "status do pedido 1042" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("PROCESSING");
    expect(res.body.awaitingConfirmation).toBe(false);
    expect(res.body.threadId).toMatch(/^wa:/);
    expect(res.headers["x-trace-id"]).toBe(res.body.traceId);
    expect(h.orderApi.cancels).toHaveLength(0);
  });

  it("two webhook calls complete a cancellation (interrupt then resume)", async () => {
    const { app, h } = appFor();
    const first = await request(app).post("/webhook/messages").send({ channel: "wa", from: ANA.phoneE164, text: "cancela o pedido 1042" });
    expect(first.body.awaitingConfirmation).toBe(true);
    expect(h.orderApi.cancels).toHaveLength(0);
    const second = await request(app).post("/webhook/messages").send({ channel: "wa", from: ANA.phoneE164, text: "sim" });
    expect(second.body.reply).toBe(templates.cancelSuccess("1042"));
    expect(h.orderApi.cancels).toHaveLength(1);
  });

  it("propagates x-trace-id", async () => {
    const { app } = appFor();
    const res = await request(app).post("/webhook/messages").set("x-trace-id", "tr_abc").send({ from: ANA.phoneE164, text: "oi" });
    expect(res.body.traceId).toBe("tr_abc");
  });

  it.each([{}, { from: ANA.phoneE164 }, { text: "oi" }, { from: "", text: "oi" }, { from: ANA.phoneE164, text: 5 }, { from: ANA.phoneE164, text: "oi", channel: "a b" }])(
    "400 for invalid payload %j",
    async (body) => {
      const res = await request(appFor().app).post("/webhook/messages").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    },
  );

  it("400 for malformed JSON", async () => {
    const res = await request(appFor().app).post("/webhook/messages").set("content-type", "application/json").send("{nope");
    expect(res.status).toBe(400);
  });

  it("empty text goes through the graph's input guard (200 with the refusal)", async () => {
    const res = await request(appFor().app).post("/webhook/messages").send({ from: ANA.phoneE164, text: "" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/Nao recebi/);
  });
});

describe("containers", () => {
  it("test container accepts overrides and keeps defaults", async () => {
    const orderApi = new InMemoryOrderApi();
    const c = createTestContainer({ orderApi });
    const t = await c.runtime.handleInbound({ channel: "wa", from: ANA.phoneE164, text: "status do pedido 1042" });
    expect(t.reply).toContain("PROCESSING");
    await c.close();
    await c.close();
  });

  it("offline container (CLI --offline) defaults to the fake LLM and runs a full cancellation", async () => {
    const c = createOfflineContainer({ LOG_LEVEL: "silent" });
    const q = await c.runtime.handleInbound({ channel: "cli", from: ANA.phoneE164, text: "cancela o pedido 1042" });
    expect(q.awaitingConfirmation).toBe(true);
    const done = await c.runtime.handleInbound({ channel: "cli", from: ANA.phoneE164, text: "sim" });
    expect(done.reply).toBe(templates.cancelSuccess("1042"));
    expect(c.orderApi.cancelCalls).toHaveLength(1);
  });
});

describe("config and CLI args", () => {
  it("loadConfig applies defaults and prefers AGENT_DATABASE_URL", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://a", AGENT_DATABASE_URL: "postgres://b", LLM_PROVIDER: "fake" });
    expect(cfg.AGENT_PORT).toBe(3002);
    expect(cfg.databaseUrl).toBe("postgres://b");
    expect(loadConfig({ DATABASE_URL: "postgres://a" }).databaseUrl).toBe("postgres://a");
  });
  it("loadConfig rejects an unsupported LLM provider", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "gpt" })).toThrow();
  });
  it("parseArgs", () => {
    expect(parseArgs(["--offline", "--phone", BRUNO.phoneE164])).toMatchObject({ offline: true, phone: BRUNO.phoneE164, channel: "cli" });
    expect(parseArgs([])).toMatchObject({ offline: false, phone: ANA.phoneE164 });
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("persistence (agent schema)", () => {
  it("PgConversationStore upserts the conversation and stores the redacted body", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const db: Queryable = {
      query: async (sql, values) => {
        calls.push({ sql, values });
        return { rows: [] };
      },
    };
    await new PgConversationStore(db).recordMessage({
      threadId: "wa:abc",
      customerRef: ANA.id,
      direction: "IN",
      body: "meu email e ana@example.com",
      intent: "CHECK_STATUS",
    });
    expect(calls[0]).toEqual({ sql: UPSERT_CONVERSATION_SQL, values: ["wa:abc", ANA.id] });
    expect(calls[1]?.sql).toBe(INSERT_MESSAGE_SQL);
    expect(calls[1]?.values).toEqual(["wa:abc", "IN", "meu email e [email]", "CHECK_STATUS"]);
  });

  it("a customerRef that is not a uuid is not written to customer_id", async () => {
    const values: unknown[][] = [];
    const db: Queryable = { query: async (_s, v) => (values.push(v ?? []), { rows: [] }) };
    await new PgConversationStore(db).recordMessage({ threadId: "wa:abc", customerRef: "cus_123", direction: "OUT", body: "ok" });
    expect(values[0]).toEqual(["wa:abc", null]);
  });

  it("the migration creates conversations, messages (body_redacted) and handoff_tickets in schema agent", () => {
    const sql = readFileSync(path.join(AGENT_MIGRATIONS_DIR, "001_agent_init.sql"), "utf8");
    expect(sql).toMatch(/CREATE SCHEMA IF NOT EXISTS agent/);
    for (const t of ["agent.conversations", "agent.messages", "agent.handoff_tickets"]) expect(sql).toContain(`CREATE TABLE ${t}`);
    expect(sql).toMatch(/body_redacted\s+text NOT NULL/);
    expect(sql).toMatch(/summary_redacted\s+text NOT NULL/);
    // the Pg handoff service inserts exactly these columns
    expect(sql).toMatch(/thread_id\s+text PRIMARY KEY/);
  });
});
