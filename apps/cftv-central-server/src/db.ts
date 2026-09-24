import path from "path";
import fs from "fs";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { Cliente, RelatorioArmazenado, UsuarioDashboard } from "./types";

export interface SessaoArmazenada {
  token: string;
  usuarioId: string;
  criadoEm: string;
  expiraEm: string;
}

interface DadosCentral {
  clientes: Cliente[];
  relatorios: RelatorioArmazenado[];
  usuarios: UsuarioDashboard[];
  sessoes: SessaoArmazenada[];
}

const DADOS_PADRAO: DadosCentral = { clientes: [], relatorios: [], usuarios: [], sessoes: [] };

const PASTA_DADOS = path.join(__dirname, "..", "data");
let db: Low<DadosCentral>;

// ---------------------------------------------------------------------
// Fila de escrita: serializa gravacoes no arquivo para evitar corrida entre
// requisicoes concorrentes (varios sites podem enviar relatorio quase ao
// mesmo tempo). Sem isso, duas escritas sobrepostas no mesmo arquivo JSON
// poderiam fazer uma sobrescrever o resultado da outra.
// ---------------------------------------------------------------------
let filaEscrita: Promise<unknown> = Promise.resolve();
export function comEscritaSerializada<T>(tarefa: () => Promise<T>): Promise<T> {
  const resultado = filaEscrita.then(tarefa, tarefa);
  filaEscrita = resultado.catch(() => undefined);
  return resultado;
}

export async function iniciarBanco(): Promise<void> {
  if (!fs.existsSync(PASTA_DADOS)) fs.mkdirSync(PASTA_DADOS, { recursive: true });
  const adapter = new JSONFile<DadosCentral>(path.join(PASTA_DADOS, "central.json"));
  db = new Low<DadosCentral>(adapter, DADOS_PADRAO);
  await db.read();
  db.data ||= DADOS_PADRAO;
  await db.write();
}

export function obterDados(): DadosCentral {
  return db.data!;
}

export async function salvar(): Promise<void> {
  await db.write();
}

/** Mantem so os ultimos N relatorios por cliente, para o arquivo nao crescer indefinidamente. */
export function podarHistoricoRelatorios(clienteId: string, manterUltimos = 500): void {
  const dados = obterDados();
  const doCliente = dados.relatorios
    .filter((r) => r.clienteId === clienteId)
    .sort((a, b) => b.recebidoEm.localeCompare(a.recebidoEm));
  if (doCliente.length <= manterUltimos) return;
  const idsParaManter = new Set(doCliente.slice(0, manterUltimos).map((r) => r.id));
  dados.relatorios = dados.relatorios.filter((r) => r.clienteId !== clienteId || idsParaManter.has(r.id));
}
