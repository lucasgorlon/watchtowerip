import express from "express";
import { iniciarBanco } from "./db";
import { rotasAuth } from "./routes/auth";
import { rotasRelatorios } from "./routes/relatorios";
import { rotasClientes } from "./routes/clientes";

async function main() {
  await iniciarBanco();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Log simples de cada requisicao (util pra depurar sites conectando via VPN)
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  app.get("/api/saude", (_req, res) => {
    res.json({ ok: true, servico: "cftv-central-server" });
  });

  app.use("/api/auth", rotasAuth);
  app.use("/api/relatorios", rotasRelatorios);
  app.use("/api/clientes", rotasClientes);

  app.use((req, res) => {
    res.status(404).json({ erro: "Rota não encontrada." });
  });

  // IMPORTANTE: HOST deve ser o IP da interface VPN da maquina que roda esse
  // servidor -- nunca 0.0.0.0 em producao, para o servico nao ficar acessivel
  // pela internet publica, so pela malha VPN. Ver README para detalhes.
  const PORTA = Number(process.env.PORT) || 4000;
  const HOST = process.env.HOST || "127.0.0.1";

  app.listen(PORTA, HOST, () => {
    console.log(`Servidor central rodando em http://${HOST}:${PORTA}`);
    if (HOST === "127.0.0.1") {
      console.warn(
        "AVISO: rodando apenas em localhost (127.0.0.1). Para os sites remotos conseguirem " +
          "enviar relatorios via VPN, defina a variavel de ambiente HOST com o IP da interface VPN desta maquina."
      );
    }
  });
}

main().catch((e) => {
  console.error("Falha ao iniciar o servidor central:", e);
  process.exit(1);
});
