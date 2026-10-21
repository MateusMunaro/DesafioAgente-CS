import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { COMPOSE_SYSTEM_PROMPT_V1, buildComposeUserPrompt } from "../prompts/compose.v1.js";
import { templates } from "../templates/index.js";
import type { ComposeFacts, ResponseComposer } from "./types.js";

/** Real composer: receives only structured facts; any failure returns the safe fallback template. */
export class LlmResponseComposer implements ResponseComposer {
  constructor(private readonly model: Pick<BaseChatModel, "invoke">) {}

  async compose(facts: ComposeFacts): Promise<string> {
    try {
      const msg = await this.model.invoke([
        { role: "system", content: COMPOSE_SYSTEM_PROMPT_V1 },
        { role: "user", content: buildComposeUserPrompt(facts) },
      ]);
      const c: unknown = (msg as { content: unknown }).content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("")
            : "";
      return text.trim() || templates.safeFallback();
    } catch {
      return templates.safeFallback();
    }
  }
}
