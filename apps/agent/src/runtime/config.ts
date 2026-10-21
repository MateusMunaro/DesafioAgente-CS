import { z } from "zod";

const Env = z.object({
  AGENT_PORT: z.coerce.number().int().positive().default(3002),
  ORDER_API_URL: z.string().url().default("http://localhost:3001"),
  ORDER_API_TOKEN: z.string().min(1).default("change-me-dev-token"),
  FAKESTORE_URL: z.string().url().default("https://fakestoreapi.com"),
  DATABASE_URL: z.string().optional(),
  AGENT_DATABASE_URL: z.string().optional(),
  LLM_PROVIDER: z.enum(["fake", "gemini"]).default("gemini"),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LLM_UNDERSTAND_MODEL: z.string().optional(),
  LLM_COMPOSE_MODEL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type AgentConfig = z.infer<typeof Env> & {
  /** Connection string of the agent schema (own DB user when AGENT_DATABASE_URL is set). */
  databaseUrl: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = Env.parse(env);
  return { ...parsed, databaseUrl: parsed.AGENT_DATABASE_URL ?? parsed.DATABASE_URL };
}

/** Env for the LLM factories, with the per-role model overrides. */
export function llmEnvFor(role: "understand" | "compose", cfg: AgentConfig): Record<string, string | undefined> {
  const model = (role === "understand" ? cfg.LLM_UNDERSTAND_MODEL : cfg.LLM_COMPOSE_MODEL) ?? cfg.LLM_MODEL;
  return {
    LLM_PROVIDER: cfg.LLM_PROVIDER,
    GOOGLE_API_KEY: cfg.GOOGLE_API_KEY ?? cfg.GEMINI_API_KEY,
    LLM_MODEL: model,
  };
}
