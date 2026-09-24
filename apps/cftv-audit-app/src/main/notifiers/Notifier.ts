/**
 * Interface comum a todos os canais de notificacao (Telegram, WhatsApp, E-mail...).
 * Qualquer novo canal so precisa implementar este contrato e ser registrado
 * em notifiers/index.ts -- o restante do sistema (auditRunner) nao muda.
 */
export interface Notifier {
  /** Nome do canal, usado em logs (ex: "telegram", "whatsapp"). */
  readonly canal: string;

  /** Indica se o canal esta configurado e pronto para uso. */
  estaConfigurado(): boolean;

  /** Envia uma mensagem de texto simples pelo canal. */
  enviarMensagem(mensagem: string): Promise<void>;
}
