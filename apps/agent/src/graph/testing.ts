import { CUSTOMER_FIXTURES } from "@desafio/contracts";
import { captureLogger } from "../adapters/testUtils.js";
import type { IntentClassifier, ResponseComposer } from "../llm/types.js";
import { FakeIntentClassifier, FakeResponseComposer } from "../llm/fake.js";
import type { OrderApiPort } from "../ports/index.js";
import { createTestContainer, type TestContainerOverrides } from "../runtime/container.js";
import { InMemoryOrderApi } from "../runtime/offline.js";
import type { OrderView } from "@desafio/contracts";
import type { Clock } from "./deps.js";
import { turnReset, type AgentStateType } from "./state.js";

export const ANA = CUSTOMER_FIXTURES[0]!;
export const BRUNO = CUSTOMER_FIXTURES[1]!;

/** Clock the test moves by hand (TC-19). */
export class ManualClock implements Clock {
  constructor(private t = Date.parse("2026-10-20T12:00:00Z")) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const minutes = (n: number): number => n * 60_000;

export class SpyClassifier implements IntentClassifier {
  calls = 0;
  constructor(private readonly inner: IntentClassifier = new FakeIntentClassifier()) {}
  classify(text: string, history?: readonly string[]) {
    this.calls++;
    return this.inner.classify(text, history);
  }
}

export class SpyComposer implements ResponseComposer {
  calls = 0;
  constructor(private readonly inner: ResponseComposer = new FakeResponseComposer()) {}
  compose(facts: Parameters<ResponseComposer["compose"]>[0]) {
    this.calls++;
    return this.inner.compose(facts);
  }
}

/** Order API wrapper that counts calls on top of any port. */
export class CountingOrderApi implements OrderApiPort {
  gets = 0;
  cancels: Array<{ orderId: string; key: string }> = [];
  constructor(readonly inner: InMemoryOrderApi | OrderApiPort = new InMemoryOrderApi()) {}
  getOrder(...a: Parameters<OrderApiPort["getOrder"]>) {
    this.gets++;
    return this.inner.getOrder(...a);
  }
  cancel(...a: Parameters<OrderApiPort["cancel"]>) {
    this.cancels.push({ orderId: a[1], key: a[2] });
    return this.inner.cancel(...a);
  }
}

/** Standard harness: in-memory everything, spies, captured logs, manual clock. */
export function harness(over: TestContainerOverrides = {}) {
  const log = captureLogger();
  const clock = new ManualClock();
  const inner = new InMemoryOrderApi();
  const orderApi = new CountingOrderApi(inner);
  const classifier = new SpyClassifier();
  const composer = new SpyComposer();
  const container = createTestContainer({ logger: log.logger, clock, orderApi, classifier, composer, ...over });
  const say = (text: string, from: string = ANA.phoneE164, channel = "wa") => container.runtime.handleInbound({ channel, from, text });
  return { container, say, log, clock, orderApi, inner, classifier, composer };
}

export const events = (log: ReturnType<typeof captureLogger>, name: string) => log.lines().filter((l) => l.event === name);

export function baseState(over: Partial<AgentStateType> = {}): AgentStateType {
  return {
    messages: [],
    channel: "wa",
    threadId: "wa:abc",
    traceId: "tr_1",
    replyTo: "+5511999990001",
    inboundText: "",
    customerRef: "c1",
    awaitingIntent: null,
    clarifyAttempts: 0,
    ...turnReset(),
    ...over,
  } as AgentStateType;
}

export const order = (status: OrderView["status"], id = "1042"): OrderView => ({
  id,
  status,
  totalAmount: 10,
  currency: "BRL",
  items: [],
  createdAt: "2026-10-19T14:00:00Z",
  shippedAt: null,
  cancelledAt: null,
});

