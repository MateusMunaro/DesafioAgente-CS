/** Fixed phrases (pt-BR). No LLM on these paths. */
export interface TemplateItem {
  name: string;
  quantity?: number;
}

function formatItems(items: readonly TemplateItem[]): string {
  if (items.length === 0) return "os itens do pedido";
  return items.map((i) => (i.quantity && i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name)).join(", ");
}

export const templates = {
  cancelConfirmation: (orderId: string, items: readonly TemplateItem[]) =>
    `Voce quer cancelar o pedido ${orderId} (${formatItems(items)})? Responda SIM para confirmar ou NAO para manter o pedido.`,
  confirmationAmbiguous: () => "Nao entendi sua resposta. Para cancelar, responda SIM; para manter o pedido, responda NAO.",
  cancelNotConfirmed: (orderId: string) => `Tudo bem, o pedido ${orderId} foi mantido e nada foi cancelado.`,
  cancelSuccess: (orderId: string) => `Pronto, o pedido ${orderId} foi cancelado.`,
  ruleOverrideRefusal: () =>
    "Nao posso ignorar as regras de atendimento. Posso consultar o status de um pedido ou ajudar a cancelar um pedido em processamento.",
  notCancellableStatus: (orderId: string, status: string) =>
    `O pedido ${orderId} esta com status ${status} e nao pode ser cancelado por aqui. Posso encaminhar voce a um atendente humano.`,
  alreadyCancelled: (orderId: string) => `O pedido ${orderId} ja esta cancelado.`,
  notFound: () => "Nao encontrei esse pedido no seu cadastro. Confira o numero e me envie novamente.",
  technicalFailure: () => "Nao consegui verificar agora. Tente novamente em instantes ou posso chamar um atendente.",
  handoff: () => "Vou encaminhar voce para um atendente humano, que continuara o atendimento.",
  safeFallback: () => "Desculpe, nao consegui responder com seguranca. Posso consultar ou cancelar um pedido, ou chamar um atendente.",
  clarificationLimit: () => "Nao consegui identificar o pedido. Vou encaminhar voce para um atendente humano para continuar.",
  askOrderId: () => "Qual e o numero do pedido?",
  askWhichOrder: (a: string, b: string) => `Voce citou dois pedidos (${a} e ${b}). Qual deles voce quer tratar primeiro?`,
} as const;
