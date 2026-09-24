import { Camera } from "./types";
import { conectar, ajustarHorario } from "./onvifClient";
import { obterHorarioReferencia } from "./ntp";

export interface ResultadoCorrecaoHorario {
  cameraId: string;
  nome: string;
  sucesso: boolean;
  erro?: string;
}

/**
 * Corrige o horario de varias cameras/canais de uma vez, empurrando o
 * horario obtido via NTP diretamente para cada dispositivo via ONVIF.
 *
 * IMPORTANTE: canais que vem do MESMO gravador compartilham um unico
 * relogio fisico (o do proprio NVR) -- entao em vez de repetir o comando
 * 32 vezes para o mesmo gravador, agrupamos por dispositivo fisico e
 * enviamos UM comando por gravador, aplicando o resultado a todos os
 * canais daquele grupo no relatorio final.
 */
export async function corrigirHorarioEmLote(
  cameras: Camera[],
  ntpServer: string,
  concorrencia = 6
): Promise<ResultadoCorrecaoHorario[]> {
  const refUtc = await obterHorarioReferencia(ntpServer);

  const grupos = new Map<string, Camera[]>();
  for (const camera of cameras) {
    const chave = chaveDedupDispositivo(camera);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave)!.push(camera);
  }

  const representantes = Array.from(grupos.values()).map((grupo) => grupo[0]);
  const resultados: ResultadoCorrecaoHorario[] = [];
  const fila = [...representantes];

  async function worker() {
    while (fila.length > 0) {
      const representante = fila.shift();
      if (!representante) break;
      const grupo = grupos.get(chaveDedupDispositivo(representante))!;

      try {
        const cam = await conectar(representante);
        await ajustarHorario(cam, refUtc);
        grupo.forEach((c) => resultados.push({ cameraId: c.id, nome: c.nome, sucesso: true }));
      } catch (e) {
        const erro = e instanceof Error ? e.message : String(e);
        grupo.forEach((c) => resultados.push({ cameraId: c.id, nome: c.nome, sucesso: false, erro }));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concorrencia, representantes.length || 1) }, () => worker()));
  return resultados;
}

function chaveDedupDispositivo(camera: Camera): string {
  // Canais do mesmo gravador compartilham o relogio fisico do NVR;
  // cameras individuais cada uma e seu proprio dispositivo.
  return camera.gravadorId || camera.id;
}
