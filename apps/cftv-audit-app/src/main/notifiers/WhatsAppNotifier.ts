import { Notifier } from "./Notifier";
import { ConfigWhatsApp } from "../types";

/**
 * PLACEHOLDER: canal WhatsApp ainda nao implementado.
 *
 * Quando for integrar de verdade, os caminhos recomendados sao:
 *  1) Meta Cloud API (oficial): requer numero de telefone dedicado,
 *     verificacao de empresa no Meta Business Manager e templates de
 *     mensagem pre-aprovados para o primeiro contato em cada janela de
 *     24h. Mais burocratico, porem estavel e sem risco de bloqueio.
 *  2) Twilio WhatsApp API: mais simples de configurar que a Meta direta,
 *     porem e um servico pago por mensagem.
 *
 * Evite bibliotecas nao-oficiais baseadas em WhatsApp Web (ex: whatsapp-web.js)
 * para uso com cliente: violam os termos de uso do WhatsApp e o numero pode
 * ser banido sem aviso.
 *
 * Para ativar: implemente os metodos abaixo seguindo o mesmo contrato de
 * TelegramNotifier.ts e registre em notifiers/index.ts.
 */
export class WhatsAppNotifier implements Notifier {
  readonly canal = "whatsapp";
  private config: ConfigWhatsApp;

  constructor(config: ConfigWhatsApp) {
    this.config = config;
  }

  estaConfigurado(): boolean {
    // Sempre retorna false ate a implementacao real ser feita
    return false;
  }

  async enviarMensagem(_mensagem: string): Promise<void> {
    throw new Error(
      "Canal WhatsApp ainda nao implementado. Veja os comentarios em WhatsAppNotifier.ts."
    );
  }
}
