export interface Cliente {
  id: string;
  nome: string;
  apiKey: string;
  criadoEm: string;
  ultimoRelatorioEm: string | null;
  ultimoRelatorioResumo: ResumoRelatorio | null;
}

/**
 * Resumo enviado periodicamente por cada app local (site) para o servidor
 * central. Cobre o que já existe hoje (conectividade + última auditoria
 * completa); os campos de saúde do gravador (HDD, rede) ficam como
 * opcionais, prontos para quando essa coleta for implementada no app local
 * -- o servidor já aceita e guarda o payload bruto mesmo que ainda não
 * exista uma tela para mostrar esses campos.
 */
export interface ResumoRelatorio {
  totalCameras: number;
  online: number;
  offline: number;
  desconhecido: number;
  ultimaAuditoria?: {
    dataHoraFim: string;
    ok: number;
    atencao: number;
    offline: number;
    manual: number;
  } | null;
  saudeGravadores?: SaudeGravador[]; // reservado para a proxima fase
}

export interface SaudeGravador {
  gravadorId: string;
  nome: string;
  discoTotalGb?: number;
  discoLivreGb?: number;
  redeMbps?: number;
}

export interface RelatorioArmazenado {
  id: string;
  clienteId: string;
  recebidoEm: string;
  resumo: ResumoRelatorio;
}

export interface UsuarioDashboard {
  id: string;
  usuario: string;
  senhaHash: string;
  criadoEm: string;
}
