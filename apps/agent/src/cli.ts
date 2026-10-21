import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { CUSTOMER_FIXTURES, E164_REGEX } from "@desafio/contracts";
import { createCliContainer } from "./runtime/container.js";

export interface CliOptions {
  offline: boolean;
  phone: string;
  channel: string;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { offline: false, phone: CUSTOMER_FIXTURES[0]?.phoneE164 ?? "+5511999990001", channel: "cli", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") opts.offline = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--phone") opts.phone = argv[++i] ?? opts.phone;
    else if (a?.startsWith("--phone=")) opts.phone = a.slice("--phone=".length);
    else if (a === "--channel") opts.channel = argv[++i] ?? opts.channel;
  }
  return opts;
}

const HELP = `Simulador de chat do agente de atendimento.

Uso: npx tsx src/cli.ts [--offline] [--phone +5511999990001] [--channel cli]

  --offline   usa adaptadores em memoria (sem Order API, sem Fake Store). LLM_PROVIDER padrao: fake
  --phone     telefone E.164 do cliente simulado (clientes de teste: ${CUSTOMER_FIXTURES.map((c) => c.phoneE164).join(", ")})
  --channel   id do canal (parte do thread_id)

Dentro do chat: /sair encerra, /telefone +55... troca o cliente simulado.
O LLM segue a variavel LLM_PROVIDER (fake | gemini).`;

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "silent" };
  const container = createCliContainer(env, opts.offline);
  let phone = opts.phone;
  const rl = createInterface({ input, output });
  console.log(`Agente de atendimento (${opts.offline ? "offline" : "online"}, LLM_PROVIDER=${env.LLM_PROVIDER ?? (opts.offline ? "fake" : "gemini")}).`);
  console.log(`Cliente simulado: ${phone}. Digite /sair para encerrar.\n`);
  try {
    rl.setPrompt("voce> ");
    rl.prompt();
    // Async iteration keeps working with piped stdin (lines arriving before we are ready).
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === "/sair" || line === "/exit") break;
      if (line.startsWith("/telefone")) {
        const next = line.split(/\s+/)[1] ?? "";
        if (E164_REGEX.test(next)) {
          phone = next;
          console.log(`Cliente simulado: ${phone}`);
        } else console.log("Telefone invalido. Use o formato E.164, ex.: +5511999990001");
        rl.prompt();
        continue;
      }
      const turn = await container.runtime.handleInbound({ channel: opts.channel, from: phone, text: line });
      console.log(`agente> ${turn.reply}`);
      if (turn.awaitingConfirmation) console.log("        (aguardando SIM ou NAO)");
      if (turn.handoff) console.log("        (encaminhado para atendente humano)");
      console.log("");
      rl.prompt();
    }
  } finally {
    rl.close();
    await container.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((err: unknown) => {
    console.error("cli failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
