export type SendResult = { kind: "SENT"; messageId: string } | { kind: "FAILED"; reason: string };

export interface MessagingPort {
  send(to: string, text: string): Promise<SendResult>;
}
