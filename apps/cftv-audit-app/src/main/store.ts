import { app } from "electron";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import {
  Camera,
  Configuracoes,
  DadosApp,
  EventoConectividade,
  ExecucaoAuditoria,
  Gravador,
} from "./types";

const PADRAO_CONFIG: Configuracoes = {
  ntpServer: "a.st1.ntp.br",
  limites: {
    desvioHorarioSegundos: 60,
    nitidezLaplaciano: 100,
    brilhoMinimo: 25,
    brilhoMaximo: 230,
  },
  agendamentoCron: "0 7 * * 1", // toda segunda-feira as 07:00
  agendamentoAtivo: false,
  heartbeat: {
    intervaloRapidoMs: 15_000, // cameras individuais (TCP) e gravadores com ISAPI ok
    intervaloLentoMs: 30_000, // gravadores no fallback ONVIF-por-canal ou TCP-gravador
  },
  filtrosAuditoria: {
    verificarHorario: true,
    verificarImagem: true,
  },
  telegram: { ativo: false, botToken: "", chatId: "" },
  whatsapp: { ativo: false },
  email: { ativo: false },
  servidorCentral: {
    ativo: false,
    url: "",
    apiKey: "",
    intervaloEnvioMs: 120_000, // 2 minutos -- e so um resumo, nao precisa ser tao frequente quanto o heartbeat
  },
};

const DADOS_PADRAO: DadosApp = {
  cameras: [],
  gravadores: [],
  configuracoes: PADRAO_CONFIG,
  historico: [],
  eventosConectividade: [],
};

let db: Low<DadosApp>;

export async function iniciarBanco(): Promise<void> {
  const pastaDados = app.getPath("userData");
  if (!fs.existsSync(pastaDados)) fs.mkdirSync(pastaDados, { recursive: true });

  const arquivo = path.join(pastaDados, "dados.json");
  const adapter = new JSONFile<DadosApp>(arquivo);
  db = new Low<DadosApp>(adapter, DADOS_PADRAO);

  await db.read();
  db.data ||= DADOS_PADRAO;

  // Garante que dados/configs novos (ex: apos update do app) tenham valores padrao
  db.data.configuracoes = { ...PADRAO_CONFIG, ...db.data.configuracoes };
  db.data.configuracoes.limites = {
    ...PADRAO_CONFIG.limites,
    ...db.data.configuracoes.limites,
  };
  db.data.configuracoes.heartbeat = {
    ...PADRAO_CONFIG.heartbeat,
    ...db.data.configuracoes.heartbeat,
  };
  db.data.configuracoes.filtrosAuditoria = {
    ...PADRAO_CONFIG.filtrosAuditoria,
    ...db.data.configuracoes.filtrosAuditoria,
  };
  db.data.configuracoes.servidorCentral = {
    ...PADRAO_CONFIG.servidorCentral,
    ...db.data.configuracoes.servidorCentral,
  };
  db.data.gravadores ||= [];
  db.data.gravadores.forEach((g) => {
    if (!g.snmp) g.snmp = { ativo: false, community: "public", porta: 161 };
  });
  db.data.eventosConectividade ||= [];

  await db.write();
}

// ---------------- Cameras ----------------
export function listarCameras(): Camera[] {
  return db.data!.cameras;
}

export async function salvarCamera(camera: Omit<Camera, "id"> & { id?: string }): Promise<Camera> {
  if (camera.id) {
    const idx = db.data!.cameras.findIndex((c) => c.id === camera.id);
    if (idx >= 0) {
      db.data!.cameras[idx] = { ...db.data!.cameras[idx], ...camera, id: camera.id };
      await db.write();
      return db.data!.cameras[idx];
    }
  }
  const nova: Camera = { ...camera, id: randomUUID() } as Camera;
  db.data!.cameras.push(nova);
  await db.write();
  return nova;
}

/** Cria varias cameras de uma vez (usado ao descobrir os canais de um gravador). */
export async function salvarCamerasEmLote(cameras: Omit<Camera, "id">[]): Promise<Camera[]> {
  const novas: Camera[] = cameras.map((c) => ({ ...c, id: randomUUID() }) as Camera);
  db.data!.cameras.push(...novas);
  await db.write();
  return novas;
}

export async function removerCamera(id: string): Promise<void> {
  db.data!.cameras = db.data!.cameras.filter((c) => c.id !== id);
  await db.write();
}

/** Atualiza apenas o status de conectividade em cache (chamado a cada ciclo do heartbeat). */
export async function atualizarStatusConectividade(
  cameraId: string,
  status: "online" | "offline",
  origemChecagem: Camera["origemUltimaChecagem"]
): Promise<{ mudou: boolean; camera: Camera | null }> {
  const camera = db.data!.cameras.find((c) => c.id === cameraId);
  if (!camera) return { mudou: false, camera: null };

  const mudou = camera.statusConectividade !== status && camera.statusConectividade !== undefined;
  const primeiraChecagem = camera.statusConectividade === undefined || camera.statusConectividade === "desconhecido";

  camera.statusConectividade = status;
  camera.origemUltimaChecagem = origemChecagem;
  if (mudou || primeiraChecagem) {
    camera.ultimaMudancaConectividadeEm = new Date().toISOString();
  }

  await db.write();
  return { mudou: mudou, camera };
}

// ---------------- Gravadores ----------------
export function listarGravadores(): Gravador[] {
  return db.data!.gravadores;
}

export function buscarGravadorPorId(id: string): Gravador | null {
  return db.data!.gravadores.find((g) => g.id === id) || null;
}

export async function salvarGravador(
  gravador: Omit<Gravador, "id" | "snmp"> & { id?: string; snmp?: Gravador["snmp"] }
): Promise<Gravador> {
  if (gravador.id) {
    const idx = db.data!.gravadores.findIndex((g) => g.id === gravador.id);
    if (idx >= 0) {
      db.data!.gravadores[idx] = { ...db.data!.gravadores[idx], ...gravador, id: gravador.id };
      await db.write();
      return db.data!.gravadores[idx];
    }
  }
  const novo: Gravador = {
    ...gravador,
    snmp: gravador.snmp ?? { ativo: false, community: "public", porta: 161 },
    id: randomUUID(),
  } as Gravador;
  db.data!.gravadores.push(novo);
  await db.write();
  return novo;
}

export async function atualizarSaudeGravador(gravadorId: string, saude: Gravador["ultimaSaude"]): Promise<void> {
  const gravador = db.data!.gravadores.find((g) => g.id === gravadorId);
  if (gravador) {
    gravador.ultimaSaude = saude;
    await db.write();
  }
}

export async function atualizarProtocoloGravador(
  gravadorId: string,
  protocolo: Gravador["protocoloGerenciamento"]
): Promise<void> {
  const gravador = db.data!.gravadores.find((g) => g.id === gravadorId);
  if (gravador && gravador.protocoloGerenciamento !== protocolo) {
    gravador.protocoloGerenciamento = protocolo;
    await db.write();
  }
}

/** Remove o gravador e, em cascata, todos os canais (cameras) associados a ele. */
export async function removerGravador(id: string): Promise<void> {
  db.data!.gravadores = db.data!.gravadores.filter((g) => g.id !== id);
  db.data!.cameras = db.data!.cameras.filter((c) => c.gravadorId !== id);
  await db.write();
}

export async function atualizarSuporteIsapi(gravadorId: string, suporta: boolean, erro?: string): Promise<void> {
  const gravador = db.data!.gravadores.find((g) => g.id === gravadorId);
  if (gravador) {
    gravador.suportaIsapi = suporta;
    gravador.ultimoErroIsapi = suporta ? undefined : erro;
    await db.write();
  }
}

export async function atualizarNivelChecagemGravador(
  gravadorId: string,
  nivel: Gravador["nivelChecagemAtual"]
): Promise<void> {
  const gravador = db.data!.gravadores.find((g) => g.id === gravadorId);
  if (gravador && gravador.nivelChecagemAtual !== nivel) {
    gravador.nivelChecagemAtual = nivel;
    await db.write();
  }
}

// ---------------- Configuracoes ----------------
export function obterConfiguracoes(): Configuracoes {
  return db.data!.configuracoes;
}

export async function salvarConfiguracoes(config: Partial<Configuracoes>): Promise<Configuracoes> {
  db.data!.configuracoes = { ...db.data!.configuracoes, ...config };
  await db.write();
  return db.data!.configuracoes;
}

// ---------------- Historico (auditoria completa manual) ----------------
export function listarHistorico(limite = 50): ExecucaoAuditoria[] {
  return db.data!.historico.slice(-limite).reverse();
}

export async function adicionarExecucao(execucao: ExecucaoAuditoria): Promise<void> {
  db.data!.historico.push(execucao);
  // mantem apenas as ultimas 200 execucoes para o arquivo nao crescer indefinidamente
  if (db.data!.historico.length > 200) {
    db.data!.historico = db.data!.historico.slice(-200);
  }
  await db.write();
}

// ---------------- Eventos de conectividade (heartbeat) ----------------
export function listarEventosConectividade(limite = 100): EventoConectividade[] {
  return db.data!.eventosConectividade.slice(-limite).reverse();
}

export async function registrarEventoConectividade(
  evento: Omit<EventoConectividade, "id">
): Promise<void> {
  db.data!.eventosConectividade.push({ ...evento, id: randomUUID() });
  // mantem apenas os ultimos 2000 eventos (cada um so e gravado em mudanca de estado, nao por ciclo)
  if (db.data!.eventosConectividade.length > 2000) {
    db.data!.eventosConectividade = db.data!.eventosConectividade.slice(-2000);
  }
  await db.write();
}
