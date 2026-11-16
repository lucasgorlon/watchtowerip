import { Cam } from "onvif";
// @ts-ignore - digest-fetch nao possui tipos oficiais
import DigestFetch from "digest-fetch";
import { Camera } from "./types";
import { testarConectividadeTcp } from "./isapiStatus";
import { ehErroAutenticacao, mensagemDe } from "./erros";

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

/** Erro de timeout do comTimeout -- usado para distinguir "demorou" de "recusou" no diagnostico. */
class ErroTempoEsgotado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroTempoEsgotado";
  }
}

export interface OpcoesConexao {
  /** Tempo maximo total da conexao (handshake ONVIF). Padrao 12s -- curto, pensado para o heartbeat. */
  timeoutMs?: number;
}

function conectar(dispositivo: CredenciaisOnvif, opcoes: OpcoesConexao = {}): Promise<Cam> {
  const timeoutTotalMs = opcoes.timeoutMs ?? 12000;
  // timeout por requisicao SOAP da biblioteca: um pouco menor que o total,
  // para que o erro "natural" da lib chegue antes do nosso comTimeout.
  const timeoutRequisicaoMs = Math.max(4000, timeoutTotalMs - 4000);

  const promessa = new Promise<Cam>((resolve, reject) => {
    const cam = new Cam(
      {
        hostname: dispositivo.ip,
        port: dispositivo.portaOnvif,
        username: dispositivo.usuario,
        password: dispositivo.senha,
        timeout: timeoutRequisicaoMs,
      },
      (err: Error | null) => {
        if (err) reject(err);
        else resolve(cam);
      }
    );
  });
  const segundos = Math.round(timeoutTotalMs / 1000);
  return comTimeout(promessa, timeoutTotalMs, `Tempo esgotado ao conectar via ONVIF (${segundos}s) -- o gravador não respondeu.`).catch(
    (e) => {
      if (e instanceof Error && e.message.startsWith("Tempo esgotado ao conectar")) throw new ErroTempoEsgotado(e.message);
      throw e;
    }
  );
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
export function descobrirCanais(cam: Cam, timeoutMs = 25000): Promise<CanalDescoberto[]> {
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
  const segundos = Math.round(timeoutMs / 1000);
  return comTimeout(
    promessa,
    timeoutMs,
    `Tempo esgotado ao descobrir canais via ONVIF (${segundos}s) -- o gravador parou de responder no meio da descoberta.`
  ).catch((e) => {
    if (e instanceof Error && e.message.startsWith("Tempo esgotado ao descobrir")) throw new ErroTempoEsgotado(e.message);
    throw e;
  });
}

// ---------------------------------------------------------------------
// Diagnostico em etapas (usado na descoberta de canais e ao retomar um
// gravador pausado). Em vez de um "Tempo esgotado (12s)" generico, cada
// etapa isola uma causa diferente:
//   1) TCP na porta ONVIF          -> porta fechada / sem rota (VPN, firewall)
//   2) GetSystemDateAndTime sem auth -> servico ONVIF desligado ou IP bloqueado
//   3) conexao com credenciais     -> usuario/senha recusados (+ desvio de relogio)
//   4) GetProfiles                 -> gravador lento para listar perfis
// ---------------------------------------------------------------------

/** Diferenca de relogio PC x gravador acima disso invalida o WS-Security (UsernameToken) em varios firmwares. */
const LIMITE_DESVIO_RELOGIO_S = 5 * 60;

export class ErroDiagnosticoOnvif extends Error {
  constructor(
    public readonly etapa: 1 | 2 | 3 | 4,
    public readonly tipo: "porta_fechada" | "onvif_sem_resposta" | "autenticacao_recusada" | "login_lento" | "erro_login" | "perfis_lentos" | "erro_perfis",
    mensagem: string
  ) {
    super(mensagem);
    this.name = "ErroDiagnosticoOnvif";
  }
}

/**
 * GetSystemDateAndTime e uma das poucas operacoes que o padrao ONVIF exige
 * que funcionem SEM autenticacao -- por isso e o teste ideal para separar
 * "ONVIF fora do ar" de "credencial errada". Feito com fetch puro (sem a lib
 * onvif) para nao enviar nenhuma tentativa de login.
 */
export async function consultarHorarioSemAutenticacao(ip: string, porta: number, timeoutMs = 10000): Promise<Date> {
  const corpo =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    '<s:Body><GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body>' +
    "</s:Envelope>";

  const controle = new AbortController();
  const temporizador = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${ip}:${porta}/onvif/device_service`, {
      method: "POST",
      headers: { "Content-Type": 'application/soap+xml; charset=utf-8; action="http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime"' },
      body: corpo,
      signal: controle.signal,
    });
    const xml = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = extrairUtcDateTime(xml);
    if (!data) throw new Error("resposta sem UTCDateTime reconhecível");
    return data;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`sem resposta em ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(temporizador);
  }
}

function extrairUtcDateTime(xml: string): Date | null {
  const bloco = xml.match(/<(?:\w+:)?UTCDateTime>([\s\S]*?)<\/(?:\w+:)?UTCDateTime>/)?.[1];
  if (!bloco) return null;
  const campo = (nome: string) => {
    const m = bloco.match(new RegExp(`<(?:\\w+:)?${nome}>(\\d+)</(?:\\w+:)?${nome}>`));
    return m ? Number(m[1]) : NaN;
  };
  const [ano, mes, dia, hora, minuto, segundo] = ["Year", "Month", "Day", "Hour", "Minute", "Second"].map(campo);
  if ([ano, mes, dia, hora, minuto, segundo].some((n) => Number.isNaN(n))) return null;
  return new Date(Date.UTC(ano, mes - 1, dia, hora, minuto, segundo));
}

function descreverDesvio(horarioGravador: Date | null): string {
  if (!horarioGravador) return "";
  const desvioS = Math.round((horarioGravador.getTime() - Date.now()) / 1000);
  if (Math.abs(desvioS) <= LIMITE_DESVIO_RELOGIO_S) return "";
  const minutos = Math.round(Math.abs(desvioS) / 60);
  const sentido = desvioS > 0 ? "adiantado" : "atrasado";
  return (
    ` Atenção: o relógio do gravador está ${minutos} min ${sentido} em relação a este PC` +
    ` (gravador: ${horarioGravador.toISOString()} UTC) -- diferenças acima de 5 min fazem alguns firmwares recusarem o login ONVIF mesmo com a senha certa.`
  );
}

export interface OpcoesDiagnostico {
  timeoutTcpMs?: number;
  timeoutSemAuthMs?: number;
  timeoutLoginMs?: number;
}

/**
 * Etapas 1 a 3: devolve a conexao ONVIF autenticada ou lanca
 * ErroDiagnosticoOnvif com a causa provavel. Faz no maximo UMA tentativa
 * de login (nao contribui para bloqueio de IP por repeticao).
 */
export async function conectarComDiagnostico(
  dispositivo: CredenciaisOnvif,
  opcoes: OpcoesDiagnostico = {}
): Promise<{ cam: Cam; horarioGravador: Date | null }> {
  const { ip, portaOnvif } = dispositivo;
  const timeoutTcpMs = opcoes.timeoutTcpMs ?? 5000;
  const timeoutSemAuthMs = opcoes.timeoutSemAuthMs ?? 15000;
  const timeoutLoginMs = opcoes.timeoutLoginMs ?? 40000;

  // 1) TCP
  const portaAberta = await testarConectividadeTcp(ip, portaOnvif, timeoutTcpMs);
  if (!portaAberta) {
    throw new ErroDiagnosticoOnvif(
      1,
      "porta_fechada",
      `Etapa 1/4 (TCP): a porta ${portaOnvif} de ${ip} está fechada ou sem rota -- confira o IP/porta, se a VPN está conectada e se há firewall no caminho.`
    );
  }

  // 2) ONVIF sem autenticacao
  let horarioGravador: Date | null = null;
  try {
    horarioGravador = await consultarHorarioSemAutenticacao(ip, portaOnvif, timeoutSemAuthMs);
  } catch (e) {
    throw new ErroDiagnosticoOnvif(
      2,
      "onvif_sem_resposta",
      `Etapa 2/4 (ONVIF sem login): a porta ${portaOnvif} está aberta, mas o serviço ONVIF não respondeu (${mensagemDe(e)}). ` +
        `Provável: ONVIF desativado no gravador, porta errada (ONVIF costuma ser a porta HTTP, ex. 80) ou IP deste PC bloqueado por tentativas de login inválidas -- aguarde o desbloqueio (normalmente 30 min) ou reinicie o gravador.`
    );
  }

  // 3) Login
  try {
    const cam = await conectar(dispositivo, { timeoutMs: timeoutLoginMs });
    return { cam, horarioGravador };
  } catch (e) {
    const desvio = descreverDesvio(horarioGravador);
    if (ehErroAutenticacao(e)) {
      throw new ErroDiagnosticoOnvif(
        3,
        "autenticacao_recusada",
        `Etapa 3/4 (login ONVIF): o gravador recusou usuário/senha. Na Hikvision o usuário ONVIF é cadastrado à parte (Configuração > Rede > Avançado > Protocolo de integração).` +
          desvio +
          " Evite repetir com a senha errada: o gravador bloqueia o IP após algumas tentativas."
      );
    }
    if (e instanceof ErroTempoEsgotado) {
      throw new ErroDiagnosticoOnvif(
        3,
        "login_lento",
        `Etapa 3/4 (login ONVIF): o ONVIF responde sem login, mas a conexão autenticada não terminou em ${Math.round(timeoutLoginMs / 1000)}s.` +
          (desvio || " Pode ser lentidão na VPN ou o gravador sobrecarregado.")
      );
    }
    throw new ErroDiagnosticoOnvif(3, "erro_login", `Etapa 3/4 (login ONVIF): ${mensagemDe(e)}.${desvio}`);
  }
}

/** Etapas 1 a 4: conecta com diagnostico e lista os canais (timeouts longos, so para a descoberta). */
export async function descobrirCanaisComDiagnostico(
  dispositivo: CredenciaisOnvif,
  opcoes: OpcoesDiagnostico & { timeoutPerfisMs?: number } = {}
): Promise<CanalDescoberto[]> {
  const { cam } = await conectarComDiagnostico(dispositivo, opcoes);
  const timeoutPerfisMs = opcoes.timeoutPerfisMs ?? 45000;
  try {
    return await descobrirCanais(cam, timeoutPerfisMs);
  } catch (e) {
    if (e instanceof ErroTempoEsgotado) {
      throw new ErroDiagnosticoOnvif(
        4,
        "perfis_lentos",
        `Etapa 4/4 (listar perfis): login OK, mas o gravador demorou mais de ${Math.round(timeoutPerfisMs / 1000)}s para listar os perfis/canais. ` +
          "Gravadores com muitos canais ou CPU alta podem demorar -- tente novamente em alguns minutos."
      );
    }
    throw new ErroDiagnosticoOnvif(4, "erro_perfis", `Etapa 4/4 (listar perfis): ${mensagemDe(e)}`);
  }
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
