import { Router } from "express";
import { exigirApiKey } from "../middlewares";
import { registrarRelatorio } from "../clientesRepo";
import { ResumoRelatorio } from "../types";

export const rotasRelatorios = Router();

function validarResumo(corpo: any): corpo is ResumoRelatorio {
  return (
    corpo &&
    typeof corpo.totalCameras === "number" &&
    typeof corpo.online === "number" &&
    typeof corpo.offline === "number" &&
    typeof corpo.desconhecido === "number"
  );
}

rotasRelatorios.post("/", exigirApiKey, async (req, res) => {
  const cliente = (req as any).cliente;
  const resumo = req.body;

  if (!validarResumo(resumo)) {
    res.status(400).json({
      erro:
        "Payload inválido. Campos obrigatórios: totalCameras, online, offline, desconhecido (números). " +
        "Opcionais: ultimaAuditoria, saudeGravadores.",
    });
    return;
  }

  const registro = await registrarRelatorio(cliente.id, resumo);
  res.status(201).json({ id: registro.id, recebidoEm: registro.recebidoEm });
});
