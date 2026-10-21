import { templates } from "../templates/index.js";
import type { InputRefusal } from "./state.js";

/** Fixed phrases used only by the graph (pt-BR). Shared phrases live in src/templates. */
export const graphReplies = {
  emptyInput: () => "Nao recebi nenhum texto. Em que posso ajudar? Posso consultar o status de um pedido ou ajudar a cancelar um pedido em processamento.",
  tooLong: () => "Sua mensagem ficou muito longa. Pode resumir em poucas frases, por favor?",
  flood: () => "Recebi muitas mensagens em pouco tempo. Aguarde um instante e envie novamente, por favor.",
  unknownCustomer: () => "Nao consegui identificar seu cadastro por este numero. Posso encaminhar voce a um atendente humano.",
  clarify: () => "Nao entendi bem. Voce quer consultar o status ou cancelar um pedido? Se sim, me informe o numero do pedido.",
  technicalHandoff: () =>
    "Nao consegui concluir agora e nao posso confirmar nada sobre o pedido. Encaminhei voce a um atendente humano, que continuara o atendimento.",
  confirmationExpired: () => "A confirmacao anterior expirou e nada foi cancelado.",
  confirmationDropped: (orderId: string) => `Sem uma confirmacao clara, mantive o pedido ${orderId} e nada foi cancelado.`,
} as const;

export function inputRefusalText(reason: InputRefusal): string {
  switch (reason) {
    case "EMPTY":
      return graphReplies.emptyInput();
    case "TOO_LONG":
      return graphReplies.tooLong();
    case "FLOOD":
      return graphReplies.flood();
    case "UNKNOWN_CUSTOMER":
      return graphReplies.unknownCustomer();
  }
}

export { templates };
