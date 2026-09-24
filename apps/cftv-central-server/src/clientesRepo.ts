import { randomUUID } from "crypto";
import { obterDados, salvar, comEscritaSerializada, podarHistoricoRelatorios } from "./db";
import { Cliente, RelatorioArmazenado, ResumoRelatorio } from "./types";
import { gerarApiKey } from "./auth";

export async function criarCliente(nome: string): Promise<Cliente> {
  const cliente: Cliente = {
    id: randomUUID(),
    nome,
    apiKey: gerarApiKey(),
    criadoEm: new Date().toISOString(),
    ultimoRelatorioEm: null,
    ultimoRelatorioResumo: null,
  };
  await comEscritaSerializada(async () => {
    obterDados().clientes.push(cliente);
    await salvar();
  });
  return cliente;
}

export function listarClientes(): Cliente[] {
  return [...obterDados().clientes].sort((a, b) => a.nome.localeCompare(b.nome));
}

export function buscarClientePorId(id: string): Cliente | null {
  return obterDados().clientes.find((c) => c.id === id) || null;
}

export function buscarClientePorApiKey(apiKey: string): Cliente | null {
  return obterDados().clientes.find((c) => c.apiKey === apiKey) || null;
}

export async function removerCliente(id: string): Promise<void> {
  await comEscritaSerializada(async () => {
    const dados = obterDados();
    dados.clientes = dados.clientes.filter((c) => c.id !== id);
    dados.relatorios = dados.relatorios.filter((r) => r.clienteId !== id);
    await salvar();
  });
}

/** Grava um novo relatorio no historico E atualiza o cache "ultimo estado" do cliente. */
export async function registrarRelatorio(clienteId: string, resumo: ResumoRelatorio): Promise<RelatorioArmazenado> {
  const registro: RelatorioArmazenado = {
    id: randomUUID(),
    clienteId,
    recebidoEm: new Date().toISOString(),
    resumo,
  };

  await comEscritaSerializada(async () => {
    const dados = obterDados();
    dados.relatorios.push(registro);

    const cliente = dados.clientes.find((c) => c.id === clienteId);
    if (cliente) {
      cliente.ultimoRelatorioEm = registro.recebidoEm;
      cliente.ultimoRelatorioResumo = resumo;
    }

    podarHistoricoRelatorios(clienteId);
    await salvar();
  });

  return registro;
}

export function listarHistoricoRelatorios(clienteId: string, limite = 100): RelatorioArmazenado[] {
  return obterDados()
    .relatorios.filter((r) => r.clienteId === clienteId)
    .sort((a, b) => b.recebidoEm.localeCompare(a.recebidoEm))
    .slice(0, limite);
}
