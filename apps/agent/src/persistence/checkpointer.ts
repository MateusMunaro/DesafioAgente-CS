import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";

export const AGENT_SCHEMA = "agent";

/** Tests and offline mode: checkpoints live in memory. */
export function createMemoryCheckpointer(): BaseCheckpointSaver {
  return new MemorySaver();
}

/** Production: checkpoints in Postgres, schema `agent`. setup() creates the library tables the first time. */
export async function createPostgresCheckpointer(pool: pg.Pool): Promise<BaseCheckpointSaver> {
  const saver = new PostgresSaver(pool, undefined, { schema: AGENT_SCHEMA });
  await saver.setup();
  return saver;
}
