import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { LlmIntentClassifier } from "./classifier.js";
import { LlmResponseComposer } from "./composer.js";
import { FakeIntentClassifier, FakeResponseComposer } from "./fake.js";
import type { IntentClassifier, LlmEnv, ResponseComposer } from "./types.js";

export type LlmRole = "understand" | "compose";
export const DEFAULT_PROVIDER = "gemini";
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export function createChatModel(role: LlmRole, env: LlmEnv = process.env): BaseChatModel {
  const provider = env.LLM_PROVIDER ?? DEFAULT_PROVIDER;
  if (provider === "fake") {
    // Scripted model, no network. Fake behaviour lives in FakeIntentClassifier/FakeResponseComposer.
    return new FakeListChatModel({ responses: ["Resposta simulada."] });
  }
  if (provider !== "gemini") throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is required when LLM_PROVIDER=gemini");
  // Temperature stays at the Gemini 3 default (1.0): Google advises against lowering it.
  // Determinism of decisions comes from the graph, not from sampling.
  return new ChatGoogleGenerativeAI({
    model: env.LLM_MODEL ?? DEFAULT_MODEL,
    apiKey,
    // Room for thinking tokens; the outputs themselves are short.
    maxOutputTokens: role === "understand" ? 1024 : 2048,
  });
}

export function createIntentClassifier(env: LlmEnv = process.env): IntentClassifier {
  if ((env.LLM_PROVIDER ?? DEFAULT_PROVIDER) === "fake") return new FakeIntentClassifier();
  return new LlmIntentClassifier(createChatModel("understand", env));
}

export function createResponseComposer(env: LlmEnv = process.env): ResponseComposer {
  if ((env.LLM_PROVIDER ?? DEFAULT_PROVIDER) === "fake") return new FakeResponseComposer();
  return new LlmResponseComposer(createChatModel("compose", env));
}
