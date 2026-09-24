import { Router } from "express";
import { exigirSessao } from "../middlewares";
import { listarClientes, buscarClientePorId, listarHistoricoRelatorios } from "../clientesRepo";

export const rotasClientes = Router();

rotasClientes.use(exigirSessao);

rotasClientes.get("/", (_req, res) => {
  // Nunca devolve a api_key nas listagens de leitura do dashboard
  const clientes = listarClientes().map(({ apiKey, ...resto }) => resto);
  res.json(clientes);
});

rotasClientes.get("/:id", (req, res) => {
  const cliente = buscarClientePorId(req.params.id);
  if (!cliente) {
    res.status(404).json({ erro: "Cliente não encontrado." });
    return;
  }
  const { apiKey, ...semApiKey } = cliente;
  res.json(semApiKey);
});

rotasClientes.get("/:id/historico", (req, res) => {
  const limite = req.query.limite ? Number(req.query.limite) : 100;
  const historico = listarHistoricoRelatorios(req.params.id, limite);
  res.json(historico);
});
