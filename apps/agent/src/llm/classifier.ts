import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MIN_CONFIDENCE, Understanding } from "@desafio/contracts";
import { UNDERSTAND_SYSTEM_PROMPT_V1, buildUnderstandUserPrompt } from "../prompts/understand.v1.js";
import type { IntentClassifier } from "./types.js";

const unclear = (): Understanding => ({ intent: "UNCLEAR", orderId: null, confidence: 0 });

/** Real classifier: structured output validated by zod; low confidence or any failure becomes UNCLEAR. */
export class LlmIntentClassifier implements IntentClassifier {
  constructor(private readonly model: Pick<BaseChatModel, "withStructuredOutput">) {}

  async classify(text: string, history: readonly string[] = []): Promise<Understanding> {
    try {
      const structured = (this.model as BaseChatModel).withStructuredOutput(Understanding) as unknown as {
        invoke(input: unknown): Promise<unknown>;
      };
      const raw = await structured.invoke([
        { role: "system", content: UNDERSTAND_SYSTEM_PROMPT_V1 },
        { role: "user", content: buildUnderstandUserPrompt(text, history) },
      ]);
      const parsed = Understanding.safeParse(raw);
      if (!parsed.success) return unclear();
      if (parsed.data.confidence < MIN_CONFIDENCE) {
        return { intent: "UNCLEAR", orderId: parsed.data.orderId, confidence: parsed.data.confidence };
      }
      return parsed.data;
    } catch {
      return unclear();
    }
  }
}
