import { Notifier } from "./Notifier";
import { TelegramNotifier } from "./TelegramNotifier";
import { WhatsAppNotifier } from "./WhatsAppNotifier";
import { EmailNotifier } from "./EmailNotifier";
import { Configuracoes } from "../types";

/** Monta a lista de notificadores configurados e prontos para uso. */
export function obterNotificadoresAtivos(config: Configuracoes): Notifier[] {
  const candidatos: Notifier[] = [
    new TelegramNotifier(config.telegram),
    new WhatsAppNotifier(config.whatsapp),
    new EmailNotifier(config.email),
  ];
  return candidatos.filter((n) => n.estaConfigurado());
}

/** Envia uma mensagem por todos os canais ativos, sem deixar um canal com erro derrubar os demais. */
export async function notificarTodos(config: Configuracoes, mensagem: string): Promise<void> {
  const notificadores = obterNotificadoresAtivos(config);
  await Promise.allSettled(
    notificadores.map(async (n) => {
      try {
        await n.enviarMensagem(mensagem);
      } catch (e) {
        console.error(`[notificadores] Falha no canal ${n.canal}:`, e);
      }
    })
  );
}

export { TelegramNotifier, WhatsAppNotifier, EmailNotifier };
export type { Notifier };
