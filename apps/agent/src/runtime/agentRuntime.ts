import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type { Logger } from "pino";
import { checkInput } from "../graph/guards.js";
import type { ConfirmInterruptPayload } from "../graph/nodes.js";
import type { SupportGraph } from "../graph/build.js";
import type { RateLimiter } from "../graph/deps.js";
import { inputRefusalText, templates } from "../graph/replies.js";
import type { MessagingPort } from "../ports/index.js";
import type { ConversationStore } from "../persistence/conversationStore.js";
import { threadIdFor } from "./threadId.js";

export interface InboundMessage {
  /** Channel id, e.g. "wa", "sms", "cli". */
  channel: string;
  /** Sender phone in E.164. Identifies the customer (S1) and is where the reply goes. */
  from: string;
  text: string;
  traceId?: string;
}

export interface TurnResult {
  threadId: string;
  traceId: string;
  /** The text sent to the customer in this turn. */
  reply: string;
  /** True when the graph is paused waiting for SIM/NAO. */
  awaitingConfirmation: boolean;
  handoff: boolean;
  intent: string | null;
}

export interface AgentRuntimeDeps {
  graph: SupportGraph;
  messaging: MessagingPort;
  store: ConversationStore;
  rateLimiter: RateLimiter;
  logger: Logger;
}

/**
 * Entry point of the agent. Maps a channel message to a thread, starts a graph run or resumes a paused one
 * (Command({ resume })), and persists the redacted conversation. Turns of the same thread never overlap.
 */
export class AgentRuntime {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: AgentRuntimeDeps) {}

  handleInbound(msg: InboundMessage): Promise<TurnResult> {
    const threadId = threadIdFor(msg.channel, msg.from);
    const prev = this.queues.get(threadId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.processTurn(msg, threadId));
    const tail = run.catch(() => undefined);
    this.queues.set(threadId, tail);
    void tail.then(() => {
      if (this.queues.get(threadId) === tail) this.queues.delete(threadId);
    });
    return run;
  }

  private async processTurn(msg: InboundMessage, threadId: string): Promise<TurnResult> {
    const { graph, logger: log } = this.deps;
    const traceId = msg.traceId ?? `tr_${randomUUID().slice(0, 8)}`;
    const config = { configurable: { thread_id: threadId } };
    log.info({ event: "agent.inbound.received", thread: threadId, traceId, channel: msg.channel, inputChars: msg.text.length });

    await this.persist(threadId, { direction: "IN", body: msg.text }, traceId);

    try {
      const snapshot = await graph.getState(config);
      const waiting = snapshot.next.includes("confirm") && snapshot.tasks.some((t) => (t.interrupts?.length ?? 0) > 0);

      if (waiting) {
        // The graph is paused on the confirmation. Input guards still apply, without consuming the interrupt.
        const verdict = checkInput(msg.text, !this.deps.rateLimiter.hit(threadId));
        if (!verdict.ok) {
          const reply = inputRefusalText(verdict.reason);
          log.info({ event: "agent.input_guard.blocked", reason: verdict.reason, inputChars: msg.text.length, thread: threadId, traceId });
          return await this.sendDirect(threadId, traceId, msg.from, reply, true);
        }
      }

      const result = (await graph.invoke(
        waiting
          ? new Command({ resume: msg.text, update: { traceId } })
          : { channel: msg.channel, threadId, traceId, replyTo: msg.from, inboundText: msg.text },
        config,
      )) as Record<string, unknown> & { __interrupt__?: Array<{ value: unknown }> };

      const intent = (result.understanding as { intent?: string } | null | undefined)?.intent ?? null;
      const handoff = Boolean(result.handoffInfo);
      const customerRef = typeof result.customerRef === "string" && result.customerRef ? result.customerRef : undefined;
      const interrupt = result.__interrupt__?.[0]?.value as ConfirmInterruptPayload | undefined;

      if (interrupt && interrupt.type === "CONFIRM_CANCEL") {
        // Turn ends here: send the question; the state is saved in the checkpointer.
        const sent = await this.deps.messaging.send(msg.from, interrupt.question);
        if (sent.kind === "FAILED") log.error({ event: "agent.send.failed", reason: sent.reason, thread: threadId, traceId });
        log.info({ event: "agent.confirm.awaiting", thread: threadId, traceId });
        await this.persist(threadId, { direction: "OUT", body: interrupt.question, intent: intent ?? undefined, customerRef }, traceId);
        return { threadId, traceId, reply: interrupt.question, awaitingConfirmation: true, handoff: false, intent };
      }

      const reply = typeof result.reply === "string" ? result.reply : templates.safeFallback();
      await this.persist(threadId, { direction: "OUT", body: reply, intent: intent ?? undefined, customerRef }, traceId);
      if (handoff) {
        try {
          await this.deps.store.markHandoff(threadId);
        } catch (err) {
          log.error({ event: "agent.persist.failed", op: "markHandoff", error: errName(err), thread: threadId, traceId });
        }
      }
      return { threadId, traceId, reply, awaitingConfirmation: false, handoff, intent };
    } catch (err) {
      // Unexpected infrastructure failure (e.g. checkpointer down): say nothing about the order.
      log.error({ event: "agent.turn.failed", error: errName(err), thread: threadId, traceId });
      return await this.sendDirect(threadId, traceId, msg.from, templates.technicalFailure(), false);
    }
  }

  private async sendDirect(threadId: string, traceId: string, to: string, text: string, persist: boolean): Promise<TurnResult> {
    try {
      await this.deps.messaging.send(to, text);
    } catch (err) {
      this.deps.logger.error({ event: "agent.send.failed", reason: errName(err), thread: threadId, traceId });
    }
    if (persist) await this.persist(threadId, { direction: "OUT", body: text }, traceId);
    return { threadId, traceId, reply: text, awaitingConfirmation: false, handoff: false, intent: null };
  }

  private async persist(
    threadId: string,
    m: { direction: "IN" | "OUT"; body: string; intent?: string | undefined; customerRef?: string | undefined },
    traceId: string,
  ): Promise<void> {
    try {
      await this.deps.store.recordMessage({ threadId, ...m });
    } catch (err) {
      this.deps.logger.error({ event: "agent.persist.failed", op: "recordMessage", error: errName(err), thread: threadId, traceId });
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "UNKNOWN";
}
