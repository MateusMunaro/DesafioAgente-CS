import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// Same relative path from src/infra/db (tsx) and dist/infra/db (compiled).
const APP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MIGRATIONS_DIR = path.join(APP_ROOT, "migrations");
export const SEED_FILE = path.join(APP_ROOT, "seed.sql");

/** Applies migrations/*.sql in name order, each in its own transaction, once. Returns the names applied now. */
export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS orders");
    await client.query(
      `CREATE TABLE IF NOT EXISTS orders.schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    for (const file of files) {
      const done = await client.query("SELECT 1 FROM orders.schema_migrations WHERE name = $1", [file]);
      if (done.rowCount) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO orders.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    client.release();
  }
  return applied;
}

/** Runs seed.sql (idempotent: every insert is guarded). */
export async function runSeed(pool: pg.Pool, file: string = SEED_FILE): Promise<void> {
  const sql = await readFile(file, "utf8");
  const client = await pool.connect();
  try {
    await client.query(sql);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
