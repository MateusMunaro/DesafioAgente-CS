/** Deterministic parsing of the customer's answer to the cancel confirmation (S6). No LLM involved. */
export type ConfirmationAnswer = "YES" | "NO" | "AMBIGUOUS" | "OTHER";

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YES_CORE = new Set(["sim", "s", "ss", "confirmo", "confirmado", "confirma", "confirmar", "positivo", "certamente", "claro"]);
const NEG = new Set(["nao", "n", "nunca", "jamais", "negativo", "nope"]);
const HEDGE_TOKENS = new Set(["acho", "talvez", "sei", "depende", "hum", "hmm", "hm", "duvida", "pensar", "sera"]);
const HEDGE_PHRASES = [/\bpode ser\b/, /\bmais ou menos\b/, /\bnao tenho certeza\b/, /\bacho que\b/, /\btanto faz\b/, /\bquem sabe\b/];
// Acknowledgements that do not say yes or no. On a destructive action they mean: ask again.
const ACK = new Set(["ok", "okay", "blz", "beleza", "uhum", "aham", "ta", "certo", "entendi", "tudo", "bem"]);
const FILLER = new Set([
  "e",
  "quero", "cancelar", "cancela", "cancele", "o", "a", "pedido", "por", "favor", "pf", "pfv", "obrigado", "obrigada", "eu", "mesmo", "isso",
  "esse", "este", "meu", "de", "jeito", "nenhum", "agora", "melhor", "pode", "com", "certeza", "que", "manter", "mantem", "mantenha", "cancelamento",
]);
const YES_PHRASES = [/^(com certeza|pode|pode sim|pode cancelar|pode confirmar|quero sim|cancela|cancele|cancela sim|cancele sim|isso mesmo|isso|quero|eu quero)$/];
const NO_PHRASES = [/^(de jeito nenhum|deixa pra la|deixa quieto|esquece|esqueca|desisti|desisto|mantem|mantenha|pode manter|manter|manter o pedido|pode manter o pedido|mantem o pedido)$/];

/**
 * @param pendingOrderId the order the pending action refers to; mentioning it again is fine,
 *   mentioning a different number makes the message a new request (OTHER).
 */
export function parseConfirmation(text: string, pendingOrderId?: string): ConfirmationAnswer {
  const norm = normalize(text);
  if (!norm) return "AMBIGUOUS";
  const tokens = norm.split(" ");

  const numbers = tokens.filter((t) => /^\d+$/.test(t));
  if (numbers.some((n) => n !== pendingOrderId)) return "OTHER";

  if (HEDGE_PHRASES.some((r) => r.test(norm)) || tokens.some((t) => HEDGE_TOKENS.has(t))) {
    // Hedging only counts as ambiguity for short answers; long text is a new request.
    return tokens.length <= 6 ? "AMBIGUOUS" : "OTHER";
  }

  if (tokens.every((t) => ACK.has(t))) return "AMBIGUOUS";

  const rest = tokens.filter((t) => !/^\d+$/.test(t));
  const hasYes = rest.some((t) => YES_CORE.has(t));
  const hasNeg = rest.some((t) => NEG.has(t));
  const allKnown = rest.every((t) => YES_CORE.has(t) || NEG.has(t) || FILLER.has(t));
  const phrase = rest.join(" ");

  if (hasYes && hasNeg && allKnown) return "AMBIGUOUS";
  if (hasNeg && allKnown) return "NO";
  if (NO_PHRASES.some((r) => r.test(phrase))) return "NO";
  if (hasYes && allKnown) return "YES";
  if (YES_PHRASES.some((r) => r.test(phrase))) return "YES";
  return "OTHER";
}
