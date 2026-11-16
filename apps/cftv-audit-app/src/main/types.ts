export type OrigemCamera = "individual" | "gravador";

export interface Camera {
  id: string;
  nome: string;
  ip: string; // para canais de gravador, e o IP do proprio gravador (usado so como referencia)
  portaOnvif: number;
  usuario: string;
  senha: string;
  marca: string;
  ativo: boolean;

  // Preenchidos apenas quando a camera foi criada a partir de um gravador
  origem: OrigemCamera;
  gravadorId?: string;
  canalToken?: string; // token do perfil ONVIF no gravador
  canalNumero?: number; // numero do canal (1-32, etc.)

  // Cache de status de conectividade (atualizado pelo heartbeat)
  statusConectividade?: "online" | "offline" | "desconhecido";
  ultimaMudancaConectividadeEm?: string; // ISO date
  origemUltimaChecagem?: "isapi" | "tcp_individual" | "onvif_canal_individual" | "tcp_gravador_fallback";
}

export type NivelChecagemGravador =
  | "isapi"
  | "onvif_canal"
  | "tcp_fallback"
  | "pausado_autenticacao" // credenciais recusadas N vezes: so TCP (sem login) ate o usuario retomar
  | "desconhecido";

export interface ConfigSnmp {
  ativo: boolean;
  community: string;
  porta: number;
}

export type ProtocoloGerenciamento = "isapi" | "dahua_cgi" | "nenhum";

export interface Gravador {
  id: string;
  nome: string;
  ip: string;
  portaOnvif: number;
  usuario: string;
  senha: string;
  ativo: boolean;
  totalCanaisDescobertos: number;
  suportaIsapi?: boolean; // descoberto na primeira consulta de status
  ultimoErroIsapi?: string; // guardado para diagnostico quando suportaIsapi === false
  nivelChecagemAtual?: NivelChecagemGravador; // define qual intervalo (rapido/lento) esse gravador usa
  snmp: ConfigSnmp; // para coleta de consumo de rede (e fallback de disco)
  ultimaSaude?: SaudeGravador; // cache do ultimo resultado de saude coletado
  protocoloGerenciamento?: ProtocoloGerenciamento; // detectado automaticamente (ISAPI vs Dahua CGI vs nenhum)

  // Protecao contra bloqueio de IP por tentativas de login (Hikvision/Intelbras
  // bloqueiam o IP de origem apos algumas senhas erradas seguidas).
  falhasAutenticacaoConsecutivas?: number;
  pausadoPorAutenticacao?: boolean; // heartbeat parou de tentar login; so TCP ate o usuario retomar
  motivoPausa?: string;
  pausadoEm?: string; // ISO
  isapiRecusouCredenciais?: boolean; // ISAPI deu 401: nao tenta mais ISAPI ate retomar (usuario ONVIF != usuario web e comum na Hikvision)

  // Cache da interface de rede usada na leitura SNMP (descoberta via ifDescr)
  snmpInterface?: { indice: number; nome: string };
}

export interface DiscoGravador {
  id: string;
  nome: string;
  status: string; // "ok", "error", "unformatted", "idle" etc
  capacidadeGb: number;
  livreGb: number;
}

export interface SaudeGravador {
  coletadoEm: string;
  discos: DiscoGravador[];
  origemDisco?: "isapi" | "dahua_cgi" | "snmp" | null;
  cpuPercent: number | null;
  memoriaUsadaMb: number | null;
  memoriaTotalMb: number | null;
  redeEntradaMbps: number | null;
  redeSaidaMbps: number | null;
  redeInterface?: string; // nome (ifDescr) da interface usada na leitura, ex. "eth0"
  erroDisco?: string;
  erroCpuMemoria?: string;
  erroRede?: string;
}

export interface Limites {
  desvioHorarioSegundos: number;
  nitidezLaplaciano: number;
  brilhoMinimo: number;
  brilhoMaximo: number;
}

export type CanalNotificacao = "telegram" | "whatsapp" | "email";

export interface ConfigTelegram {
  ativo: boolean;
  botToken: string;
  chatId: string;
}

/** Placeholders para os canais futuros — a interface Notifier já está pronta para eles. */
export interface ConfigWhatsApp {
  ativo: boolean;
  provedor?: "meta_cloud_api" | "twilio";
  apiKey?: string;
  numeroDestino?: string;
}

export interface ConfigEmail {
  ativo: boolean;
  smtpHost?: string;
  smtpPorta?: number;
  usuario?: string;
  senha?: string;
  destinatarios?: string[];
}

export interface ConfigHeartbeat {
  intervaloRapidoMs: number; // usado para cameras individuais (TCP) e gravadores com ISAPI funcionando
  intervaloLentoMs: number; // usado para gravadores que caem no fallback ONVIF-por-canal ou TCP-gravador
}

export interface FiltrosAuditoria {
  verificarHorario: boolean;
  verificarImagem: boolean;
}

export interface ConfigServidorCentral {
  ativo: boolean;
  url: string; // ex: http://10.8.0.1:4000 (dentro da VPN)
  apiKey: string;
  intervaloEnvioMs: number;
}

/** Espelha o formato aceito pelo endpoint POST /api/relatorios do servidor central. */
export interface ResumoRelatorioCentral {
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
  saudeGravadores?: {
    gravadorId: string;
    nome: string;
    discoTotalGb?: number;
    discoLivreGb?: number;
    redeMbps?: number;
  }[];
}

export interface Configuracoes {
  ntpServer: string;
  limites: Limites;
  agendamentoCron: string; // formato cron, ex: "0 7 * * 1" (toda segunda 07:00)
  agendamentoAtivo: boolean;
  heartbeat: ConfigHeartbeat;
  filtrosAuditoria: FiltrosAuditoria;
  telegram: ConfigTelegram;
  whatsapp: ConfigWhatsApp;
  email: ConfigEmail;
  servidorCentral: ConfigServidorCentral;
}

export type StatusCamera =
  | "OK"
  | "ATENCAO"
  | "OFFLINE"
  | "VERIFICAR_MANUALMENTE";

export interface ResultadoCamera {
  cameraId: string;
  nome: string;
  ip: string;
  canalNumero: number | null; // numero do canal no gravador (null para camera individual, sem gravador)
  gravadorId: string | null;
  statusGeral: StatusCamera;
  horarioStatus: string;
  desvioSegundos: number | null;
  imagemStatus: string;
  nitidezValor: number | null;
  brilhoValor: number | null;
  erro: string | null;
}

export interface ExecucaoAuditoria {
  id: string;
  dataHoraInicio: string;
  dataHoraFim: string;
  totalCameras: number;
  ok: number;
  atencao: number;
  offline: number;
  manual: number;
  resultados: ResultadoCamera[];
}

export interface DadosApp {
  cameras: Camera[];
  gravadores: Gravador[];
  configuracoes: Configuracoes;
  historico: ExecucaoAuditoria[];
  eventosConectividade: EventoConectividade[];
}

/** Registro leve de mudanca de estado (nao um log por ciclo de polling). */
export interface EventoConectividade {
  id: string;
  cameraId: string;
  nome: string;
  dataHora: string; // ISO
  novoStatus: "online" | "offline";
}
