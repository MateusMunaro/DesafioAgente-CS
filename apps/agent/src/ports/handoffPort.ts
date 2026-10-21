export const HANDOFF_REASONS = ["OUT_OF_SCOPE", "API_FAILURE", "USER_REQUEST", "AMBIGUITY"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export interface Ticket {
  id: string;
  conversationId: string;
  reason: HandoffReason;
  /** Summary with PII already redacted. */
  summary: string;
  /** UNPERSISTED: the ticket could not be stored; the caller may still hand the customer over. */
  status: "OPEN" | "UNPERSISTED";
  createdAt: string;
}

export interface HandoffPort {
  open(conversationId: string, reason: HandoffReason, summary: string): Promise<Ticket>;
}
