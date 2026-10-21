import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";

// Same relative path from src/persistence (tsx) and dist/persistence (compiled).
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const AGENT_MIGRATIONS_DIR = path.join(APP_ROOT, "migrations");

/** Applies migrations/*.sql in name order, each in its own transaction, once. Returns the names applied now. */
export async function runAgentMigrations(pool: pg.Pool, dir: string = AGENT_MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS agent");
    await client.query(
      `CREATE TABLE IF NOT EXISTS agent.schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    for (const file of files) {
      const done = await client.query("SELECT 1 FROM agent.schema_migrations WHERE name = $1", [file]);
      if (done.rowCount) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO agent.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Agent migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    client.release();
  }
  return applied;
}
