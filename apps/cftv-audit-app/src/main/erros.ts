/**
 * Erro de credencial recusada pelo dispositivo (HTTP 401 no ISAPI, SOAP
 * fault NotAuthorized no ONVIF etc). Separado dos demais erros porque o
 * tratamento e diferente: insistir com credencial errada faz o
 * Hikvision/Intelbras bloquear o IP de origem por varios minutos.
 */
export class ErroAutenticacao extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroAutenticacao";
  }
}

const PADRAO_ERRO_AUTENTICACAO =
  /not ?authori[sz]ed|unauthori[sz]ed|\b401\b|sender not authorized|authentication fail|invalid (user|password|credentials)|wrong password|ter:NotAuthorized/i;

/** Heuristica para reconhecer falha de autenticacao em erros vindos das bibliotecas (onvif, digest-fetch). */
export function ehErroAutenticacao(erro: unknown): boolean {
  if (erro instanceof ErroAutenticacao) return true;
  const mensagem = erro instanceof Error ? erro.message : String(erro ?? "");
  return PADRAO_ERRO_AUTENTICACAO.test(mensagem);
}

export function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
