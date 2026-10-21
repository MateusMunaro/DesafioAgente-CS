import { CUSTOMER_FIXTURES, E164_REGEX, type CustomerFixture } from "@desafio/contracts";
import type { CustomerDirectoryPort, CustomerLookup } from "../../ports/index.js";

/** Directory backed by the seed customers shared with the Order API. customerRef is the customer id. */
export class StaticCustomerDirectory implements CustomerDirectoryPort {
  constructor(private readonly customers: readonly CustomerFixture[] = CUSTOMER_FIXTURES) {}

  async resolveByPhone(phoneE164: string): Promise<CustomerLookup> {
    if (!E164_REGEX.test(phoneE164)) return { kind: "NOT_FOUND" };
    const found = this.customers.find((c) => c.phoneE164 === phoneE164);
    return found ? { kind: "FOUND", customerRef: found.id } : { kind: "NOT_FOUND" };
  }
}
