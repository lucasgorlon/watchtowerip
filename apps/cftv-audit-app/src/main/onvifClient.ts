import { Cam } from "onvif";
// @ts-ignore - digest-fetch nao possui tipos oficiais
import DigestFetch from "digest-fetch";
import { Camera } from "./types";

/** Credenciais ONVIF minimas, compativeis tanto com Camera quanto com Gravador. */
export interface CredenciaisOnvif {
  ip: string;
  portaOnvif: number;
  usuario: string;
  senha: string;
}

/**
 * Envolve uma Promise com um timeout de seguranca -- rejeita com erro claro
 * se a promise original nao resolver nem rejeitar dentro do prazo.
 *
 * Existe porque a biblioteca 'onvif' nem sempre honra o timeout configurado
 * em TODAS as chamadas -- confirmado com um gravador real (Hikvision
 * DS-7732NI-K4, credenciais corretas, validadas via curl) em que
 * `getProfiles` travava indefinidamente, nunca chamando o callback de
 * sucesso nem de erro. Sem essa rede de seguranca, uma chamada travada
 * trava o handler de IPC inteiro para sempre -- e o Electron relata
 * "reply was never sent" (um erro pouco claro) em vez de um erro legivel
 * de timeout.
 */
function comTimeout<T>(promise: Promise<T>, ms: number, mensagem: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const temporizador = setTimeout(() => reject(new Error(mensagem)), ms);
    promise.then(
      (valor) => {
        clearTimeout(temporizador);
        resolve(valor);
      },
      (erro) => {
        clearTimeout(temporizador);
        reject(erro);
      }
    );
  });
}

function conectar(dispositivo: CredenciaisOnvif): Promise<Cam> {
  const promessa = new Promise<Cam>((resolve, reject) => {
    const cam = new Cam(
      {
        hostname: dispositivo.ip,
        port: dispositivo.portaOnvif,
        username: dispositivo.usuario,
        password: dispositivo.senha,
        timeout: 8000,
      },
      (err: Error | null) => {
        if (err) reject(err);
        else resolve(cam);
      }
    );
  });
  return comTimeout(promessa, 12000, "Tempo esgotado ao conectar via ONVIF (12s) -- o gravador não respondeu.");
}

export interface ResultadoHorario {
  horarioCamera: string;
  desvioSegundos: number;
  status: "OK" | "DESVIO_DE_HORARIO";
}

/** Consulta o relogio interno da camera via ONVIF e compara com o horario de referencia (NTP). */
export function verificarHorario(
  cam: Cam,
  refUtc: Date,
  limiteSegundos: number
): Promise<ResultadoHorario> {
  const promessa = new Promise<ResultadoHorario>((resolve, reject) => {
    cam.getSystemDateAndTime((err: Error | null, data: any) => {
      if (err) {
        reject(err);
        return;
      }
      // A biblioteca 'onvif' retorna um objeto Date already parsed em UTC
      const horarioCamera: Date = data instanceof Date ? data : new Date(data);
      const desvioSegundos = Math.abs((horarioCamera.getTime() - refUtc.getTime()) / 1000);

      resolve({
        horarioCamera: horarioCamera.toISOString(),
        desvioSegundos: Math.round(desvioSegundos * 10) / 10,
        status: desvioSegundos <= limiteSegundos ? "OK" : "DESVIO_DE_HORARIO",
      });
    });
  });
  return comTimeout(promessa, 10000, "Tempo esgotado ao consultar o horário via ONVIF (10s).");
}

/**
 * Obtem a URL do snapshot via ONVIF e baixa a imagem (com autenticacao Digest).
 * Quando a camera veio de um gravador (canalToken preenchido), o token
 * garante que o snapshot e do canal correto -- sem ele, a biblioteca ONVIF
 * usa o primeiro perfil disponivel no dispositivo (canal 1).
 */
export function obterSnapshot(cam: Cam, camera: Camera): Promise<Buffer> {
  const promessa = new Promise<Buffer>((resolve, reject) => {
    const opcoes = camera.canalToken ? { profileToken: camera.canalToken } : {};
    cam.getSnapshotUri(opcoes, async (err: Error | null, data: any) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const client = new DigestFetch(camera.usuario, camera.senha);
        const resp = await client.fetch(data.uri);
        if (!resp.ok) {
          reject(new Error(`HTTP ${resp.status} ao baixar snapshot`));
          return;
        }
        const arrayBuffer = await resp.arrayBuffer();
        resolve(Buffer.from(arrayBuffer));
      } catch (e) {
        reject(e);
      }
    });
  });
  return comTimeout(promessa, 15000, "Tempo esgotado ao obter o snapshot via ONVIF (15s).");
}

export interface CanalDescoberto {
  token: string;
  nome: string;
  canalNumero: number;
}

/**
 * Conecta no gravador via ONVIF e lista seus canais (um "profile" ONVIF por canal).
 * Funciona com qualquer NVR compativel com ONVIF Profile S (inclui o Intelbras iNVD 3032).
 *
 * IMPORTANTE: a maioria dos NVRs expõe DOIS perfis ONVIF por canal fisico --
 * um para o stream principal (alta qualidade) e outro para o substream (baixa
 * qualidade, usado em grades de visualizacao). GetProfiles() retorna todos
 * eles misturados, entao uma leitura ingenua duplica (ou triplica) a
 * contagem real de cameras. Aqui agrupamos os perfis pelo `sourceToken` da
 * VideoSourceConfiguration -- que identifica o canal fisico de verdade -- e
 * mantemos apenas o perfil de maior resolucao (o stream principal) de cada
 * grupo.
 */
export function descobrirCanais(cam: Cam): Promise<CanalDescoberto[]> {
  const promessa = new Promise<CanalDescoberto[]>((resolve, reject) => {
    cam.getProfiles((err: Error | null, profiles: any[]) => {
      if (err) {
        reject(err);
        return;
      }

      const grupos = new Map<string, any[]>();
      (profiles || []).forEach((perfil, indice) => {
        // sourceToken identifica o canal fisico; se ausente (NVR nao informou
        // videoSourceConfiguration), usa o proprio indice como chave -- nesse
        // caso nao ha como deduplicar e cada perfil vira um "canal".
        const chave: string =
          perfil?.videoSourceConfiguration?.sourceToken ||
          perfil?.videoSourceConfiguration?.$?.token ||
          `sem-fonte-${indice}`;
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave)!.push(perfil);
      });

      const canais: CanalDescoberto[] = Array.from(grupos.values()).map((perfisDoCanal, indice) => {
        const escolhido = escolherStreamPrincipal(perfisDoCanal);
        return {
          token: escolhido?.$?.token || escolhido?.token || `perfil-${indice}`,
          nome: escolhido?.name || `Canal ${indice + 1}`,
          canalNumero: indice + 1,
        };
      });

      resolve(canais);
    });
  });
  return comTimeout(
    promessa,
    25000,
    "Tempo esgotado ao descobrir canais via ONVIF (25s) -- o gravador parou de responder no meio da descoberta."
  );
}

/** Entre os perfis do mesmo canal fisico (main/substream), escolhe o de maior resolucao. */
function escolherStreamPrincipal(perfis: any[]): any {
  if (perfis.length === 1) return perfis[0];

  return perfis.reduce((melhor, atual) => {
    const areaMelhor = areaDoPerfil(melhor);
    const areaAtual = areaDoPerfil(atual);
    return areaAtual > areaMelhor ? atual : melhor;
  }, perfis[0]);
}

function areaDoPerfil(perfil: any): number {
  const resolucao = perfil?.videoEncoderConfiguration?.resolution;
  if (!resolucao?.width || !resolucao?.height) return 0;
  return resolucao.width * resolucao.height;
}

/**
 * Checagem LEVE de disponibilidade do canal via ONVIF: pede a URI do
 * snapshot e testa a resposta HTTP (preferencialmente com HEAD, sem baixar
 * a imagem) -- ao contrario de obterSnapshot(), nao baixa nem processa a
 * imagem inteira. E mais pesada que um simples ping TCP (envolve 1 chamada
 * SOAP + 1 requisicao HTTP por canal), mas ainda muito mais leve que a
 * auditoria completa, e funciona mesmo quando o gravador nao suporta ISAPI.
 *
 * Alguns servidores embarcados nao aceitam HEAD (respondem 405/501); nesse
 * caso a funcao cai para um GET e cancela a leitura do corpo assim que o
 * cabecalho HTTP chega, sem baixar o arquivo completo.
 */
export function verificarSnapshotDisponivel(cam: Cam, camera: Camera): Promise<boolean> {
  const promessa = new Promise<boolean>((resolve) => {
    const opcoes = camera.canalToken ? { profileToken: camera.canalToken } : {};
    cam.getSnapshotUri(opcoes, async (err: Error | null, data: any) => {
      if (err || !data?.uri) {
        resolve(false);
        return;
      }
      try {
        const client = new DigestFetch(camera.usuario, camera.senha);
        let resp = await client.fetch(data.uri, { method: "HEAD" });
        if (resp.status === 405 || resp.status === 501) {
          resp = await client.fetch(data.uri, { method: "GET" });
          try {
            // @ts-ignore - cancel() existe em Response.body (ReadableStream) no fetch nativo
            resp.body?.cancel?.();
          } catch {
            /* ignora falha ao cancelar leitura do corpo */
          }
        }
        resolve(resp.ok);
      } catch {
        resolve(false);
      }
    });
  });
  // Timeout aqui resolve false (canal indisponivel) em vez de rejeitar --
  // mantem o contrato da funcao (nunca lanca erro) e evita travar o
  // heartbeat inteiro por causa de UM canal que parou de responder.
  return comTimeout(promessa, 8000, "timeout").catch(() => false);
}

/**
 * Roda verificarSnapshotDisponivel() para varios canais do mesmo gravador,
 * reaproveitando UMA UNICA conexao/handshake ONVIF em vez de reconectar por
 * canal.
 */
export async function verificarCanaisViaOnvif(
  gravador: CredenciaisOnvif,
  canais: Camera[],
  concorrencia = 6
): Promise<Map<number, boolean>> {
  const cam = await conectar(gravador);
  const resultado = new Map<number, boolean>();
  const fila = [...canais];

  async function worker() {
    while (fila.length > 0) {
      const camera = fila.shift();
      if (!camera || camera.canalNumero === undefined) continue;
      const online = await verificarSnapshotDisponivel(cam, camera);
      resultado.set(camera.canalNumero, online);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concorrencia, canais.length || 1) }, () => worker()));
  return resultado;
}

/**
 * Empurra o horario correto (ja obtido via NTP pelo proprio app) diretamente
 * para o dispositivo via ONVIF. Mais confiavel que apontar a camera para um
 * NTP externo, porque nao depende da camera conseguir alcancar esse servidor
 * -- o app ja fez essa parte e so envia o resultado pronto.
 */
export function ajustarHorario(cam: Cam, dataHoraUtc: Date): Promise<void> {
  const promessa = new Promise<void>((resolve, reject) => {
    cam.setSystemDateAndTime(
      { dateTimeType: "Manual", dateTime: dataHoraUtc, daylightSavings: false },
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
  return comTimeout(promessa, 10000, "Tempo esgotado ao ajustar o horário via ONVIF (10s).");
}

export { conectar };
export type { Cam };
