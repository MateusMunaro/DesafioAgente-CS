import { type Intent, type Understanding, ORDER_ID_REGEX } from "@desafio/contracts";
import { templates } from "../templates/index.js";
import type { ComposeFacts, IntentClassifier, ResponseComposer } from "./types.js";

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const INJECTION = [
  /ignor\w*\s+(as\s+|suas\s+|todas\s+as\s+|todas\s+)?(regras|instrucoes|politicas)/,
  /esquec\w*\s+(as\s+|suas\s+)?(regras|instrucoes)/,
  /(revel\w*|mostr\w*|exib\w*|diga)\s+.*(prompt|instrucoes|system)/,
  /system\s*prompt|prompt\s+do\s+sistema/,
  /ignore\s+(all|previous|the)\b/,
  /\bsou\s+(o\s+|a\s+)?(gerente|administrador|admin|dono|supervisor|desenvolvedor)/,
  /finja\s+(que|ser)|a partir de agora voce/,
  /modo\s+(deus|admin|desenvolvedor)|jailbreak/,
];
const NEG_CANCEL = /\b(nao|nunca|jamais)\s+(quero|preciso|desejo|vou|pretendo|gostaria\s+de|e\s+para)\s+(mais\s+)?cancel/;
const NEG_CANCEL2 = /\b(nao|nunca)\s+cancel/;
const NEG_CANCEL3 = /\bdesconsidere\b.*\bcancel|\bnao\s+(precisa|quero)\s+mais\s+cancel/;
const CANCEL = /\bcancel\w*|\bdesist\w*\s+d[oae]\s+(pedido|compra)/;
const HUMAN = /\b(atendente|humano|pessoa\s+de\s+verdade|falar\s+com\s+(alguem|uma\s+pessoa|um\s+atendente)|absurdo|inaceitavel|pessimo|horrivel|vou\s+processar|procon)\b/;
const STATUS = /\b(status|situacao|rastre\w*|onde\s+esta|cade|andamento|acompanhar|ja\s+(foi\s+)?enviad\w*|consultar)\b/;
const PRODUCT = /\b(produto|preco|estoque|tamanho|cor|disponivel|modelo|garantia|quanto\s+custa)\b/;
const OUT = /\b(troca\w*|trocar|reembolso|devol\w*|endereco|reclama\w*|estorno|nota\s+fiscal|boleto)\b/;
const GREETING = /^\s*(oi+|ola+|bom\s+dia|boa\s+tarde|boa\s+noite|e\s+ai|opa|hey|hello|hi)\b[\s!.,?]*$/;

const CONTACT_KEYWORD = /\b(meu\s+n[uú]mero|tel|telefone|fone|celular|cel|whats(app)?|zap|contato|cpf|cep)\b[\s:.\-é]*(?:(?:e|eh|é|meu|o|numero|n[º°o]?)\s+)*[+\d(][\d\s().+-]*\d/gi;
const NUMBER_RUN = /\+?\(?\d[\d\s().-]{6,}\d/g;

/**
 * Removes phone numbers, CPF, CEP and other contact numbers so their fragments are never read as
 * order numbers ("tel +55 31 97777-0003" is not order 97777).
 */
export function stripContactNumbers(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, " ")
    .replace(CONTACT_KEYWORD, " ")
    .replace(NUMBER_RUN, (run) => {
      const groups = run.match(/\d+/g) ?? [];
      const digits = groups.join("").length;
      // A list of order numbers ("1042 1043") has only groups of 4+ digits and plain spaces.
      const looksLikeContact = /[+()]/.test(run) || /\d[.-]\d/.test(run) || groups.some((g) => g.length < 4);
      return digits >= 8 && looksLikeContact ? " " : run;
    });
}

export function extractOrderIds(text: string): string[] {
  const out: string[] = [];
  // Numbers glued to "/" or "-" are dates, CEPs or codes, not order numbers.
  for (const m of stripContactNumbers(text).match(/(?<![\d.,/-])\d{4,10}(?![\d/-])/g) ?? []) {
    if (ORDER_ID_REGEX.test(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Deterministic pt-BR heuristic classifier; needs no network or API key. */
export class FakeIntentClassifier implements IntentClassifier {
  async classify(text: string, _history: readonly string[] = []): Promise<Understanding> {
    const t = norm(text);
    const ids = extractOrderIds(t);
    const orderId = ids[0] ?? null;
    const res = (intent: Intent, confidence = 0.9, id: string | null = orderId): Understanding => ({
      intent,
      orderId: id,
      confidence,
    });

    if (INJECTION.some((r) => r.test(t))) return res("RULE_OVERRIDE_ATTEMPT", 0.95, null);
    if (NEG_CANCEL.test(t) || NEG_CANCEL2.test(t) || NEG_CANCEL3.test(t)) {
      return orderId ? res("CHECK_STATUS", 0.7) : res("UNCLEAR", 0.4);
    }
    if (HUMAN.test(t)) return res("HUMAN_REQUEST", 0.9, null);
    if (CANCEL.test(t)) return res("CANCEL_ORDER");
    if (OUT.test(t)) return res("OUT_OF_SCOPE", 0.85, null);
    if (STATUS.test(t)) return res("CHECK_STATUS");
    if (PRODUCT.test(t)) return res("PRODUCT_QUESTION", 0.8, null);
    if (GREETING.test(t)) return res("GREETING", 0.95, null);
    if (orderId) return res("CHECK_STATUS", 0.65);
    return res("UNCLEAR", 0.3, null);
  }
}

/** Builds text from structured facts only, deterministically. */
export class FakeResponseComposer implements ResponseComposer {
  async compose(facts: ComposeFacts): Promise<string> {
    if (facts.cancelResult === "SUCCESS" && facts.orderId) return templates.cancelSuccess(facts.orderId);
    if (facts.cancelResult === "NOT_FOUND") return templates.notFound();
    if (facts.cancelResult === "TECHNICAL_ERROR") return templates.technicalFailure();
    if (facts.cancelResult === "NOT_CANCELLABLE") {
      if (facts.orderId && facts.orderStatus) return templates.notCancellableStatus(facts.orderId, facts.orderStatus);
      return "Nao foi possivel cancelar este pedido. Posso chamar um atendente.";
    }
    if (facts.intent === "GREETING") return "Ola! Posso consultar o status de um pedido ou ajudar a cancelar um pedido em processamento.";
    const parts: string[] = [];
    if (facts.orderId && facts.orderStatus) {
      parts.push(`O pedido ${facts.orderId} esta com status ${facts.orderStatus}.`);
      if (facts.items && facts.items.length && !facts.degraded) {
        parts.push(
          `Itens: ${facts.items.map((i) => (i.quantity && i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name)).join(", ")}.`,
        );
      }
    } else if (facts.note) {
      parts.push(facts.note);
    } else {
      parts.push("Nao tenho essa informacao.");
    }
    if (facts.handoff) parts.push(facts.handoff);
    return parts.join(" ");
  }
}
