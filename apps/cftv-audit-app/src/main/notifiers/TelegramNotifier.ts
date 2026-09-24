import { Notifier } from "./Notifier";
import { ConfigTelegram } from "../types";

export class TelegramNotifier implements Notifier {
  readonly canal = "telegram";
  private config: ConfigTelegram;

  constructor(config: ConfigTelegram) {
    this.config = config;
  }

  estaConfigurado(): boolean {
    return this.config.ativo && !!this.config.botToken && !!this.config.chatId;
  }

  async enviarMensagem(mensagem: string): Promise<void> {
    if (!this.estaConfigurado()) {
      throw new Error("Telegram nao esta configurado (token/chat id ausentes)");
    }

    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text: mensagem,
        parse_mode: "HTML",
      }),
    });

    if (!resp.ok) {
      const corpo = await resp.text().catch(() => "");
      throw new Error(`Falha ao enviar mensagem Telegram (HTTP ${resp.status}): ${corpo}`);
    }
  }
}
