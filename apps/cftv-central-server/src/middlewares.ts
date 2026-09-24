import { Request, Response, NextFunction } from "express";
import { validarSessao } from "./auth";
import { buscarClientePorApiKey } from "./clientesRepo";

const NOME_COOKIE_SESSAO = "cftv_sessao";

export function obterCookie(req: Request, nome: string): string | null {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  const partes = cabecalho.split(";").map((p) => p.trim());
  for (const parte of partes) {
    const [chave, ...resto] = parte.split("=");
    if (chave === nome) return decodeURIComponent(resto.join("="));
  }
  return null;
}

export function definirCookieSessao(res: Response, token: string): void {
  // httpOnly: JS do navegador nao consegue ler o cookie (mitiga XSS)
  // SameSite=Strict: cookie so vai em requisicoes originadas do proprio dashboard
  // Sem "Secure" porque o servidor roda em HTTP simples dentro da VPN (sem TLS publico)
  res.setHeader(
    "Set-Cookie",
    `${NOME_COOKIE_SESSAO}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 60 * 60}`
  );
}

export function limparCookieSessao(res: Response): void {
  res.setHeader("Set-Cookie", `${NOME_COOKIE_SESSAO}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/** Middleware: exige uma sessao de dashboard valida (cookie). */
export function exigirSessao(req: Request, res: Response, next: NextFunction) {
  const token = obterCookie(req, NOME_COOKIE_SESSAO);
  if (!token) {
    res.status(401).json({ erro: "Não autenticado." });
    return;
  }
  const sessao = validarSessao(token);
  if (!sessao) {
    res.status(401).json({ erro: "Sessão expirada ou inválida." });
    return;
  }
  (req as any).usuarioId = sessao.usuarioId;
  next();
}

/** Middleware: exige uma API key valida de cliente (header X-Api-Key). */
export function exigirApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.header("X-Api-Key");
  if (!apiKey) {
    res.status(401).json({ erro: "Header X-Api-Key ausente." });
    return;
  }
  const cliente = buscarClientePorApiKey(apiKey);
  if (!cliente) {
    res.status(401).json({ erro: "API key inválida." });
    return;
  }
  (req as any).cliente = cliente;
  next();
}

export { NOME_COOKIE_SESSAO };
