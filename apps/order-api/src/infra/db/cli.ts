import pg from "pg";
import { runMigrations, runSeed } from "./migrate.js";

/** Usage: tsx src/infra/db/cli.ts migrate|seed  (reads DATABASE_URL) */
async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (command !== "migrate" && command !== "seed") throw new Error("usage: cli.ts migrate|seed");

  const pool = new pg.Pool({ connectionString: url });
  try {
    if (command === "migrate") {
      const applied = await runMigrations(pool);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "migrations: nothing to apply");
    } else {
      await runSeed(pool);
      console.log("seed: done");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
