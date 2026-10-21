import { createHash } from "node:crypto";

/** thread_id = channel:hash(phone). The phone itself never appears in thread ids, logs or the database key. */
export function threadIdFor(channel: string, phoneE164: string): string {
  const hash = createHash("sha256").update(phoneE164).digest("hex").slice(0, 16);
  return `${channel}:${hash}`;
}
