import { z } from "zod";

const boolFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  ORDER_API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ORDER_API_TOKEN: z.string().min(1, "ORDER_API_TOKEN is required"),
  LOG_LEVEL: z.string().default("info"),
  /** Run migrations/*.sql at startup (handy for docker compose). */
  AUTO_MIGRATE: boolFlag,
  /** Run seed.sql at startup (demo data). */
  AUTO_SEED: boolFlag,
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
