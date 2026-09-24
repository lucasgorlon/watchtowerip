import { Notifier } from "./Notifier";
import { ConfigEmail } from "../types";

/**
 * PLACEHOLDER: canal E-mail ainda nao implementado.
 *
 * Quando for implementar, a forma mais simples e usar 'nodemailer' (pura
 * JS, sem dependencias nativas) apontando para o SMTP da propria empresa
 * ou um servico como SendGrid/SES. Para ativar: implemente os metodos
 * abaixo seguindo o mesmo contrato de TelegramNotifier.ts e registre em
 * notifiers/index.ts.
 */
export class EmailNotifier implements Notifier {
  readonly canal = "email";
  private config: ConfigEmail;

  constructor(config: ConfigEmail) {
    this.config = config;
  }

  estaConfigurado(): boolean {
    return false;
  }

  async enviarMensagem(_mensagem: string): Promise<void> {
    throw new Error("Canal E-mail ainda nao implementado. Veja os comentarios em EmailNotifier.ts.");
  }
}
