import { Router } from "express";
import { buscarUsuarioPorNome, verificarSenha, criarSessao, encerrarSessao } from "../auth";
import { definirCookieSessao, limparCookieSessao, obterCookie, exigirSessao, NOME_COOKIE_SESSAO } from "../middlewares";

export const rotasAuth = Router();

rotasAuth.post("/login", async (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) {
    res.status(400).json({ erro: "Informe usuário e senha." });
    return;
  }

  const registro = buscarUsuarioPorNome(usuario);
  if (!registro || !verificarSenha(senha, registro.senhaHash)) {
    // Mensagem generica de proposito -- nao revela se o usuario existe ou nao
    res.status(401).json({ erro: "Usuário ou senha inválidos." });
    return;
  }

  const sessao = await criarSessao(registro.id);
  definirCookieSessao(res, sessao.token);
  res.json({ usuario: registro.usuario });
});

rotasAuth.post("/logout", async (req, res) => {
  const token = obterCookie(req, NOME_COOKIE_SESSAO);
  if (token) await encerrarSessao(token);
  limparCookieSessao(res);
  res.json({ ok: true });
});

rotasAuth.get("/me", exigirSessao, (req, res) => {
  res.json({ usuarioId: (req as any).usuarioId });
});
