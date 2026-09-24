import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";
import { obterDados, salvar, comEscritaSerializada } from "./db";
import { UsuarioDashboard } from "./types";

const DURACAO_SESSAO_HORAS = 12;

// ---------------------------------------------------------------------
// Senhas: scrypt (nativo do Node, sem dependencia externa tipo bcrypt)
// ---------------------------------------------------------------------
export function gerarHashSenha(senha: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(senha, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verificarSenha(senha: string, hashArmazenado: string): boolean {
  const [salt, hashOriginal] = hashArmazenado.split(":");
  if (!salt || !hashOriginal) return false;
  const hashTentativa = scryptSync(senha, salt, 64).toString("hex");
  const bufOriginal = Buffer.from(hashOriginal, "hex");
  const bufTentativa = Buffer.from(hashTentativa, "hex");
  if (bufOriginal.length !== bufTentativa.length) return false;
  return timingSafeEqual(bufOriginal, bufTentativa);
}

// ---------------------------------------------------------------------
// Usuarios do dashboard
// ---------------------------------------------------------------------
export async function criarUsuario(usuario: string, senha: string): Promise<UsuarioDashboard> {
  const registro: UsuarioDashboard = {
    id: randomUUID(),
    usuario,
    senhaHash: gerarHashSenha(senha),
    criadoEm: new Date().toISOString(),
  };
  await comEscritaSerializada(async () => {
    obterDados().usuarios.push(registro);
    await salvar();
  });
  return registro;
}

export function buscarUsuarioPorNome(usuario: string): UsuarioDashboard | null {
  return obterDados().usuarios.find((u) => u.usuario === usuario) || null;
}

// ---------------------------------------------------------------------
// Sessoes do dashboard (token opaco, guardado em cookie httpOnly)
// ---------------------------------------------------------------------
export async function criarSessao(usuarioId: string): Promise<{ token: string; expiraEm: string }> {
  const token = randomBytes(32).toString("hex");
  const agora = new Date();
  const expiraEm = new Date(agora.getTime() + DURACAO_SESSAO_HORAS * 60 * 60 * 1000).toISOString();

  await comEscritaSerializada(async () => {
    obterDados().sessoes.push({ token, usuarioId, criadoEm: agora.toISOString(), expiraEm });
    await salvar();
  });

  return { token, expiraEm };
}

export function validarSessao(token: string): { usuarioId: string } | null {
  const sessao = obterDados().sessoes.find((s) => s.token === token);
  if (!sessao) return null;
  if (new Date(sessao.expiraEm).getTime() < Date.now()) {
    // expirada -- remove em segundo plano, sem bloquear a checagem atual
    comEscritaSerializada(async () => {
      obterDados().sessoes = obterDados().sessoes.filter((s) => s.token !== token);
      await salvar();
    }).catch(() => undefined);
    return null;
  }
  return { usuarioId: sessao.usuarioId };
}

export async function encerrarSessao(token: string): Promise<void> {
  await comEscritaSerializada(async () => {
    obterDados().sessoes = obterDados().sessoes.filter((s) => s.token !== token);
    await salvar();
  });
}

// ---------------------------------------------------------------------
// API key dos clientes (sites) -- usada pelo app local pra autenticar
// quando envia os relatorios
// ---------------------------------------------------------------------
export function gerarApiKey(): string {
  return randomBytes(24).toString("hex");
}
