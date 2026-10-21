/** Seed customers shared by the Order API seed and the agent customer directory. */
export interface CustomerFixture {
  id: string;
  phoneE164: string;
  displayName: string;
}

export const CUSTOMER_FIXTURES: readonly CustomerFixture[] = [
  { id: "11111111-1111-4111-8111-111111111111", phoneE164: "+5511999990001", displayName: "Ana Souza" },
  { id: "22222222-2222-4222-8222-222222222222", phoneE164: "+5521988880002", displayName: "Bruno Lima" },
  { id: "33333333-3333-4333-8333-333333333333", phoneE164: "+5531977770003", displayName: "Carla Mendes" },
];

export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function findCustomerByPhone(phoneE164: string): CustomerFixture | undefined {
  return CUSTOMER_FIXTURES.find((c) => c.phoneE164 === phoneE164);
}

export function findCustomerById(id: string): CustomerFixture | undefined {
  return CUSTOMER_FIXTURES.find((c) => c.id === id);
}
