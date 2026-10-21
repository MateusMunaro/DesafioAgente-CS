export type CustomerLookup = { kind: "FOUND"; customerRef: string } | { kind: "NOT_FOUND" };

export interface CustomerDirectoryPort {
  /** Resolves the channel phone (E.164) to the opaque customerRef sent as X-Customer-Ref. */
  resolveByPhone(phoneE164: string): Promise<CustomerLookup>;
}
