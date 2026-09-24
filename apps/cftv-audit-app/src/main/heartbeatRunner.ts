import { Camera, Gravador, NivelChecagemGravador } from "./types";
import {
  listarCameras,
  atualizarStatusConectividade,
  registrarEventoConectividade,
  atualizarSuporteIsapi,
  obterConfiguracoes,
} from "./store";
import { consultarStatusCanaisIsapi, testarConectividadeTcp } from "./isapiStatus";
import { verificarCanaisViaOnvif } from "./onvifClient";
import { notificarTodos } from "./notifiers";

export interface ResultadoHeartbeat {
  cameraId: string;
  nome: string;
  statusAnterior: string | undefined;
  statusNovo: "online" | "offline";
  mudou: boolean;
  origemChecagem: Camera["origemUltimaChecagem"];
}

/**
 * Checa conectividade de cameras individuais (nao vinculadas a gravador)
 * via TCP direto. Leve o suficiente para rodar sempre no intervalo rapido,
 * independente da quantidade de cameras.
 */
export async function executarHeartbeatIndividuais(): Promise<ResultadoHeartbeat[]> {
  const individuais = listarCameras().filter((c) => c.ativo && c.origem !== "gravador");

  const resultados = await Promise.all(
    individuais.map(async (camera) => {
      const online = await testarConectividadeTcp(camera.ip, camera.portaOnvif);
      return aplicarResultado(camera, online, "tcp_individual");
    })
  );

  return resultados;
}

/**
 * Checa conectividade de todos os canais de UM gravador, em 3 camadas
 * (ISAPI em lote -> ISAPI por canal -> ONVIF por canal -> TCP no gravador
 * como ultimo recurso). Retorna tambem qual foi o nivel efetivamente usado,
 * para que quem chamou (o agendador) possa decidir o proximo intervalo
 * (rapido para isapi, lento para onvif_canal/tcp_fallback).
 */
export async function executarHeartbeatGravador(
  gravador: Gravador
): Promise<{ resultados: ResultadoHeartbeat[]; nivel: NivelChecagemGravador }> {
  const canais = listarCameras().filter(
    (c) => c.ativo && c.origem === "gravador" && c.gravadorId === gravador.id
  );

  if (canais.length === 0) {
    return { resultados: [], nivel: "desconhecido" };
  }

  // 1) e 2): ISAPI em lote, com fallback interno para ISAPI por canal
  try {
    const numerosDosCanais = canais
      .map((c) => c.canalNumero)
      .filter((n): n is number => n !== undefined);
    const statusPorCanal = await consultarStatusCanaisIsapi(gravador, numerosDosCanais);
    await atualizarSuporteIsapi(gravador.id, true);

    const resultados = await Promise.all(
      canais.map((camera) => {
        const online = camera.canalNumero !== undefined ? statusPorCanal.get(camera.canalNumero) : undefined;
        return aplicarResultado(camera, online ?? false, "isapi");
      })
    );

    return { resultados, nivel: "isapi" };
  } catch (eIsapi) {
    const mensagemErro = eIsapi instanceof Error ? eIsapi.message : String(eIsapi);
    await atualizarSuporteIsapi(gravador.id, false, mensagemErro);
  }

  // 3) ONVIF por canal (mais pesado, mas ainda automatico e com granularidade por canal)
  try {
    const statusPorCanalOnvif = await verificarCanaisViaOnvif(gravador, canais);

    const resultados = await Promise.all(
      canais.map((camera) => {
        const online = camera.canalNumero !== undefined ? statusPorCanalOnvif.get(camera.canalNumero) : undefined;
        return aplicarResultado(camera, online ?? false, "onvif_canal_individual");
      })
    );

    return { resultados, nivel: "onvif_canal" };
  } catch (eOnvif) {
    // 4) Ultimo recurso: TCP no gravador como um todo (nao distingue canal)
    const gravadorOnline = await testarConectividadeTcp(gravador.ip, gravador.portaOnvif);

    const resultados = await Promise.all(
      canais.map((camera) => aplicarResultado(camera, gravadorOnline, "tcp_gravador_fallback"))
    );

    return { resultados, nivel: "tcp_fallback" };
  }
}

async function aplicarResultado(
  camera: Camera,
  online: boolean,
  origem: Camera["origemUltimaChecagem"]
): Promise<ResultadoHeartbeat> {
  const statusAnterior = camera.statusConectividade;
  const statusNovo: "online" | "offline" = online ? "online" : "offline";

  const { mudou } = await atualizarStatusConectividade(camera.id, statusNovo, origem);

  if (mudou) {
    await registrarEventoConectividade({
      cameraId: camera.id,
      nome: camera.nome,
      dataHora: new Date().toISOString(),
      novoStatus: statusNovo,
    });

    const config = obterConfiguracoes();
    const emoji = statusNovo === "online" ? "🟢" : "🔴";
    const mensagem =
      statusNovo === "offline"
        ? `${emoji} <b>${camera.nome}</b> ficou OFFLINE (${camera.ip})`
        : `${emoji} <b>${camera.nome}</b> voltou a ficar ONLINE (${camera.ip})`;
    notificarTodos(config, mensagem).catch((e) => console.error("[heartbeat] Falha ao notificar:", e));
  }

  return { cameraId: camera.id, nome: camera.nome, statusAnterior, statusNovo, mudou, origemChecagem: origem };
}
