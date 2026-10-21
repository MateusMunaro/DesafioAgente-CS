import type { Intent, Understanding } from "@desafio/contracts";

export type CancelResult = "SUCCESS" | "NOT_CANCELLABLE" | "NOT_FOUND" | "TECHNICAL_ERROR";

/** Structured facts handed to the composer. The composer never decides anything. */
export interface ComposeFacts {
  intent?: Intent;
  orderId?: string | null;
  orderStatus?: string;
  items?: Array<{ name: string; quantity?: number }>;
  cancelResult?: CancelResult;
  degraded?: boolean;
  /** Fixed handoff phrase to offer the human agent. */
  handoff?: string;
  note?: string;
}

export interface IntentClassifier {
  classify(text: string, history?: readonly string[]): Promise<Understanding>;
}

export interface ResponseComposer {
  compose(facts: ComposeFacts): Promise<string>;
}

export interface LlmEnv {
  LLM_PROVIDER?: string | undefined;
  GOOGLE_API_KEY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
  LLM_MODEL?: string | undefined;
  [k: string]: string | undefined;
}
