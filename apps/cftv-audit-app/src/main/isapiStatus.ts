// @ts-ignore - digest-fetch nao possui tipos oficiais
import DigestFetch from "digest-fetch";
import net from "net";
import { Gravador } from "./types";
import { ErroAutenticacao } from "./erros";

/**
 * Consulta o status (online/offline) dos canais de um gravador via ISAPI
 * (padrao Hikvision, tambem usado por diversas linhas Intelbras).
 *
 * A documentacao oficial da Hikvision (RaCM/ISAPI) define o endpoint como
 * POR CANAL: /ISAPI/ContentMgmt/InputProxy/channels/{ID}/status -- nao existe
 * uma rota padrao "todos os canais de uma vez" garantida em todo firmware.
 * Por isso a estrategia e:
 *   1) tenta primeiro a rota em lote (alguns firmwares suportam, e e mais
 *      eficiente quando existe);
 *   2) se falhar (ex: 404), cai para uma consulta por canal -- ainda assim
 *      centralizada no gravador, sem tocar em cada camera individualmente;
 *   3) se nem isso funcionar, quem chamou deve usar o fallback de TCP.
 */
export async function consultarStatusCanaisIsapi(
  gravador: Gravador,
  canais: number[]
): Promise<Map<number, boolean>> {
  try {
    return await consultarStatusEmLote(gravador);
  } catch (erroLote) {
    // Credencial recusada: NAO cai para a consulta por canal -- seriam mais
    // N logins errados seguidos, o que bloqueia o IP no Hikvision/Intelbras.
    if (erroLote instanceof ErroAutenticacao) throw erroLote;
    return await consultarStatusPorCanal(gravador, canais);
  }
}

const MENSAGEM_ISAPI_401 =
  "ISAPI recusou usuário/senha (HTTP 401) -- ISAPI suspenso para este gravador para não bloquear o IP por tentativas de login.";

async function consultarStatusEmLote(gravador: Gravador): Promise<Map<number, boolean>> {
  const client = new DigestFetch(gravador.usuario, gravador.senha);
  const url = `http://${gravador.ip}:${gravador.portaOnvif}/ISAPI/ContentMgmt/InputProxy/channels/status`;

  const resp = await client.fetch(url, { method: "GET" });
  if (resp.status === 401) throw new ErroAutenticacao(MENSAGEM_ISAPI_401);
  if (!resp.ok) {
    throw new Error(`ISAPI (lote) respondeu HTTP ${resp.status}`);
  }

  const xml = await resp.text();
  return extrairStatusDoXml(xml);
}

/**
 * Consulta o status canal por canal (endpoint oficial da Hikvision). Ainda
 * assim e leve: cada resposta e um XML pequeno, sem download de imagem, e
 * as chamadas rodam em paralelo com um limite de concorrencia.
 */
async function consultarStatusPorCanal(
  gravador: Gravador,
  canais: number[],
  concorrencia = 8
): Promise<Map<number, boolean>> {
  const resultado = new Map<number, boolean>();
  const client = new DigestFetch(gravador.usuario, gravador.senha);
  const fila = [...canais];
  let recusouCredenciais = false;

  async function consultarCanal(canal: number) {
    try {
      const url = `http://${gravador.ip}:${gravador.portaOnvif}/ISAPI/ContentMgmt/InputProxy/channels/${canal}/status`;
      const resp = await client.fetch(url, { method: "GET" });
      if (resp.status === 401) {
        recusouCredenciais = true; // para todos os workers na hora
        return;
      }
      if (!resp.ok) return; // deixa esse canal de fora do Map (tratado como offline por quem chama)
      const xml = await resp.text();
      const mapaUnico = extrairStatusDoXml(xml);
      // resposta de canal unico normalmente vem sem <id>, ou com o proprio id -- usa o numero do canal como chave garantida
      const online = mapaUnico.size > 0 ? Array.from(mapaUnico.values())[0] : false;
      resultado.set(canal, online);
    } catch {
      // canal individual falhou -- fica de fora do Map, tratado como offline
    }
  }

  async function worker() {
    while (fila.length > 0 && !recusouCredenciais) {
      const canal = fila.shift();
      if (canal === undefined) break;
      await consultarCanal(canal);
    }
  }

  // O primeiro canal vai sozinho: se a senha estiver errada, so 1 login
  // falho e enviado (em vez de `concorrencia` logins simultaneos).
  const primeiro = fila.shift();
  if (primeiro !== undefined) await consultarCanal(primeiro);
  if (!recusouCredenciais) {
    await Promise.all(Array.from({ length: Math.min(concorrencia, fila.length || 1) }, () => worker()));
  }

  if (recusouCredenciais) throw new ErroAutenticacao(MENSAGEM_ISAPI_401);

  if (resultado.size === 0) {
    throw new Error("Nenhum canal respondeu ao ISAPI individualmente -- endpoint provavelmente nao suportado por este gravador");
  }

  return resultado;
}

/**
 * Extrai pares (numero do canal -> online/offline) do XML retornado pelo
 * ISAPI. Feito com regex simples e tolerante em vez de um parser XML
 * completo, pois a estrutura varia levemente entre firmwares/fabricantes,
 * mas os campos <id> e <online> sao consistentes na pratica.
 */
function extrairStatusDoXml(xml: string): Map<number, boolean> {
  const resultado = new Map<number, boolean>();

  // Cada bloco de canal fica entre <InputProxyChannelStatus>...</InputProxyChannelStatus>
  const blocos = xml.match(/<InputProxyChannelStatus>[\s\S]*?<\/InputProxyChannelStatus>/g);

  if (!blocos || blocos.length === 0) {
    throw new Error("XML do ISAPI nao contem blocos de status reconheciveis");
  }

  for (const bloco of blocos) {
    const idMatch = bloco.match(/<id>(\d+)<\/id>/);
    const onlineMatch = bloco.match(/<online>(true|false)<\/online>/i);
    if (idMatch && onlineMatch) {
      const canal = parseInt(idMatch[1], 10);
      const online = onlineMatch[1].toLowerCase() === "true";
      resultado.set(canal, online);
    }
  }

  if (resultado.size === 0) {
    throw new Error("Nao foi possivel extrair nenhum status de canal do XML retornado");
  }

  return resultado;
}

/**
 * Fallback: testa apenas se o proprio gravador esta acessivel via TCP na
 * porta ONVIF. Nao distingue canais individuais -- e usado somente quando
 * o gravador nao suporta a consulta detalhada via ISAPI.
 */
export function testarConectividadeTcp(host: string, porta: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolvido = false;

    const finalizar = (resultado: boolean) => {
      if (resolvido) return;
      resolvido = true;
      socket.destroy();
      resolve(resultado);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalizar(true));
    socket.once("timeout", () => finalizar(false));
    socket.once("error", () => finalizar(false));

    socket.connect(porta, host);
  });
}
