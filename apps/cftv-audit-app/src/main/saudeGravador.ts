// @ts-ignore - digest-fetch nao possui tipos oficiais
import DigestFetch from "digest-fetch";
import * as snmp from "net-snmp";
import { DiscoGravador, Gravador, SaudeGravador } from "./types";
import { detectarProtocoloGerenciamento, obterStatusDiscosDahua } from "./protocoloGravador";
import { atualizarProtocoloGravador } from "./store";

// ---------------------------------------------------------------------
// Disco (HDD) via ISAPI -- /ISAPI/ContentMgmt/Storage
// Formato confirmado: <storage><hddList><hdd><id>/<hddName>/<status>/
// <capacity>/<freeSpace>...</hdd></hddList></storage>. capacity e freeSpace
// vem em MB.
// ---------------------------------------------------------------------
export async function obterStatusDiscos(gravador: Gravador): Promise<DiscoGravador[]> {
  const client = new DigestFetch(gravador.usuario, gravador.senha);
  const url = `http://${gravador.ip}:${gravador.portaOnvif}/ISAPI/ContentMgmt/Storage`;

  const resp = await client.fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`ISAPI Storage respondeu HTTP ${resp.status}`);
  }
  const xml = await resp.text();
  return extrairDiscosDoXml(xml);
}

function extrairDiscosDoXml(xml: string): DiscoGravador[] {
  const blocos = xml.match(/<hdd>[\s\S]*?<\/hdd>/g);
  if (!blocos || blocos.length === 0) {
    throw new Error("XML do ISAPI Storage nao contem nenhum <hdd> reconhecivel");
  }

  const discos: DiscoGravador[] = [];
  for (const bloco of blocos) {
    const id = bloco.match(/<id>(\d+)<\/id>/)?.[1] ?? "?";
    const nome = bloco.match(/<hddName>(.*?)<\/hddName>/)?.[1] ?? `HDD ${id}`;
    const status = bloco.match(/<status>(.*?)<\/status>/)?.[1] ?? "desconhecido";
    const capacidadeMb = Number(bloco.match(/<capacity>(\d+)<\/capacity>/)?.[1] ?? 0);
    const livreMb = Number(bloco.match(/<freeSpace>(\d+)<\/freeSpace>/)?.[1] ?? 0);

    discos.push({
      id,
      nome,
      status,
      capacidadeGb: Math.round((capacidadeMb / 1024) * 10) / 10,
      livreGb: Math.round((livreMb / 1024) * 10) / 10,
    });
  }
  return discos;
}

// ---------------------------------------------------------------------
// CPU / memoria via ISAPI -- /ISAPI/System/status
// ---------------------------------------------------------------------
export async function obterCpuMemoria(
  gravador: Gravador
): Promise<{ cpuPercent: number | null; memoriaUsadaMb: number | null; memoriaTotalMb: number | null }> {
  const client = new DigestFetch(gravador.usuario, gravador.senha);
  const url = `http://${gravador.ip}:${gravador.portaOnvif}/ISAPI/System/status`;

  const resp = await client.fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`ISAPI System/status respondeu HTTP ${resp.status}`);
  }
  const xml = await resp.text();

  // <CPUList><CPU><cpuUtilization>NN</cpuUtilization></CPU></CPUList>
  // <MemoryList><Memory><memoryUsage>NN</memoryUsage><memoryAvailable>NN</memoryAvailable></Memory></MemoryList>
  // memoryUsage/memoryAvailable costumam vir em MB; cpuUtilization em %.
  const cpuMatch = xml.match(/<cpuUtilization>([\d.]+)<\/cpuUtilization>/);
  const usoMatch = xml.match(/<memoryUsage>([\d.]+)<\/memoryUsage>/);
  const disponivelMatch = xml.match(/<memoryAvailable>([\d.]+)<\/memoryAvailable>/);

  const memoriaUsadaMb = usoMatch ? Number(usoMatch[1]) : null;
  const memoriaDisponivelMb = disponivelMatch ? Number(disponivelMatch[1]) : null;

  return {
    cpuPercent: cpuMatch ? Number(cpuMatch[1]) : null,
    memoriaUsadaMb,
    memoriaTotalMb:
      memoriaUsadaMb !== null && memoriaDisponivelMb !== null
        ? Math.round((memoriaUsadaMb + memoriaDisponivelMb) * 10) / 10
        : null,
  };
}

// ---------------------------------------------------------------------
// Consumo de rede via SNMP -- IF-MIB (contadores de octetos por interface)
//
// Nao existe um endpoint ISAPI padronizado para trafego de rede em tempo
// real (so velocidade nominal do link, que e diferente de consumo). SNMP
// e o caminho padrao da industria pra isso.
//
// Faz DUAS leituras dos contadores com um intervalo entre elas e calcula
// a taxa (bytes/segundo -> Mbps) pela diferenca. Prefere os contadores de
// 64 bits (ifHCInOctets/ifHCOutOctets) quando disponiveis, pois os de 32
// bits (ifInOctets/ifOutOctets) estouram (wrap) em poucos minutos num link
// gigabit sob carga alta -- nesse caso o calculo pode ficar incorreto no raro
// momento exato do estouro, mas se recupera sozinho na leitura seguinte.
// ---------------------------------------------------------------------

const OID_IF_IN_OCTETS = "1.3.6.1.2.1.2.2.1.10"; // 32 bits, Counter32
const OID_IF_OUT_OCTETS = "1.3.6.1.2.1.2.2.1.16";
const OID_IF_HC_IN_OCTETS = "1.3.6.1.2.1.31.1.1.1.6"; // 64 bits, Counter64
const OID_IF_HC_OUT_OCTETS = "1.3.6.1.2.1.31.1.1.1.10";
const INDICE_INTERFACE_PADRAO = 1; // interface de rede principal, na maioria dos gravadores

function criarSessaoSnmp(gravador: Gravador): snmp.Session {
  return snmp.createSession(gravador.ip, gravador.snmp.community, {
    port: gravador.snmp.porta,
    timeout: 4000,
    retries: 1,
    version: snmp.Version2c,
  });
}

function lerContadores(sessao: snmp.Session, oidsEntradaSaida: [string, string]): Promise<[bigint, bigint]> {
  return new Promise((resolve, reject) => {
    sessao.get(oidsEntradaSaida, (err: Error | null, varbinds?: any[]) => {
      if (err) {
        reject(err);
        return;
      }
      if (!varbinds || varbinds.length < 2) {
        reject(new Error("Resposta SNMP vazia ou incompleta"));
        return;
      }
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) {
          reject(new Error(snmp.varbindError(vb)));
          return;
        }
      }
      resolve([BigInt(varbinds[0].value.toString()), BigInt(varbinds[1].value.toString())]);
    });
  });
}

export async function obterConsumoRede(
  gravador: Gravador,
  intervaloAmostraMs = 1000
): Promise<{ entradaMbps: number; saidaMbps: number }> {
  const sessao = criarSessaoSnmp(gravador);

  try {
    const idx = INDICE_INTERFACE_PADRAO;
    let usar64Bits = true;
    let oidsEntradaSaida: [string, string] = [`${OID_IF_HC_IN_OCTETS}.${idx}`, `${OID_IF_HC_OUT_OCTETS}.${idx}`];

    let amostra1: [bigint, bigint];
    try {
      amostra1 = await lerContadores(sessao, oidsEntradaSaida);
    } catch {
      // Fallback para contadores de 32 bits se os de 64 nao forem suportados
      usar64Bits = false;
      oidsEntradaSaida = [`${OID_IF_IN_OCTETS}.${idx}`, `${OID_IF_OUT_OCTETS}.${idx}`];
      amostra1 = await lerContadores(sessao, oidsEntradaSaida);
    }

    await new Promise((r) => setTimeout(r, intervaloAmostraMs));

    const amostra2 = await lerContadores(sessao, oidsEntradaSaida);

    const limite = usar64Bits ? BigInt(2) ** BigInt(64) : BigInt(2) ** BigInt(32);
    const deltaEntrada = ((amostra2[0] - amostra1[0]) + limite) % limite;
    const deltaSaida = ((amostra2[1] - amostra1[1]) + limite) % limite;

    const segundos = intervaloAmostraMs / 1000;
    const entradaMbps = (Number(deltaEntrada) * 8) / segundos / 1_000_000;
    const saidaMbps = (Number(deltaSaida) * 8) / segundos / 1_000_000;

    return {
      entradaMbps: Math.round(entradaMbps * 100) / 100,
      saidaMbps: Math.round(saidaMbps * 100) / 100,
    };
  } finally {
    sessao.close();
  }
}

const OID_HR_STORAGE_ENTRY = "1.3.6.1.2.1.25.2.3.1"; // HOST-RESOURCES-MIB::hrStorageEntry
const OID_HR_STORAGE_FIXED_DISK = "1.3.6.1.2.1.25.2.1.4"; // hrStorageFixedDisk (filtra RAM/swap fora)

function caminharSubarvore(sessao: snmp.Session, oidBase: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const varbinds: any[] = [];
    sessao.subtree(
      oidBase,
      (chunk: any[]) => {
        varbinds.push(...chunk);
      },
      (erro: Error | null) => {
        if (erro) reject(erro);
        else resolve(varbinds);
      }
    );
  });
}

/**
 * Fallback GENERICO (nao especifico de fabricante) de disco via SNMP,
 * usando HOST-RESOURCES-MIB::hrStorageTable. So funciona se o agente SNMP
 * do gravador implementar essa MIB -- nem todo firmware embarcado
 * implementa (muitos so tem IF-MIB para rede) -- por isso e a ULTIMA
 * tentativa, depois de ISAPI e CGI Dahua.
 */
export async function obterStatusDiscosSnmp(gravador: Gravador): Promise<DiscoGravador[]> {
  const sessao = criarSessaoSnmp(gravador);
  try {
    const varbinds = await caminharSubarvore(sessao, OID_HR_STORAGE_ENTRY);
    if (varbinds.length === 0) {
      throw new Error("Agente SNMP nao retornou nenhuma entrada em hrStorageTable");
    }

    const linhas = new Map<string, Record<number, any>>();
    for (const vb of varbinds) {
      if (snmp.isVarbindError(vb)) continue;
      const partes = String(vb.oid).split(".");
      const linha = partes[partes.length - 1];
      const coluna = Number(partes[partes.length - 2]);
      if (!linhas.has(linha)) linhas.set(linha, {});
      linhas.get(linha)![coluna] = vb.value;
    }

    const discos: DiscoGravador[] = [];
    linhas.forEach((colunas, linha) => {
      const tipo = String(colunas[2] ?? "");
      const ehDiscoFixo = tipo.replace(/^\./, "") === OID_HR_STORAGE_FIXED_DISK;
      if (!ehDiscoFixo) return;

      const descr = colunas[3]?.toString?.() ?? `Volume ${linha}`;
      const unidadeBytes = Number(colunas[4] ?? 0);
      const tamanhoUnidades = Number(colunas[5] ?? 0);
      const usadoUnidades = Number(colunas[6] ?? 0);
      if (!unidadeBytes || !tamanhoUnidades) return;

      const capacidadeGb = Math.round(((tamanhoUnidades * unidadeBytes) / 1024 ** 3) * 10) / 10;
      const livreGb =
        Math.round((((tamanhoUnidades - usadoUnidades) * unidadeBytes) / 1024 ** 3) * 10) / 10;

      discos.push({ id: linha, nome: descr, status: "ok", capacidadeGb, livreGb });
    });

    if (discos.length === 0) {
      throw new Error("hrStorageTable nao contem nenhum volume do tipo hrStorageFixedDisk");
    }

    return discos;
  } finally {
    sessao.close();
  }
}

// ---------------------------------------------------------------------
// Coleta completa de um gravador -- roda os coletores em camadas:
//  disco: ISAPI -> CGI Dahua -> SNMP generico (a que funcionar primeiro)
//  cpu/memoria: so via ISAPI por enquanto (Dahua/SNMP genericos ficam
//    para uma proxima etapa -- nao ha um endpoint padrao confiavel o
//    suficiente para isso nos dois fabricantes ainda)
//  rede: SNMP (IF-MIB), como ja estava
// ---------------------------------------------------------------------
export async function coletarSaudeGravador(gravador: Gravador): Promise<SaudeGravador> {
  const resultado: SaudeGravador = {
    coletadoEm: new Date().toISOString(),
    discos: [],
    origemDisco: null,
    cpuPercent: null,
    memoriaUsadaMb: null,
    memoriaTotalMb: null,
    redeEntradaMbps: null,
    redeSaidaMbps: null,
  };

  // Detecta (ou reaproveita do cache) qual protocolo de gerenciamento o
  // gravador fala, para saber que coletor de disco/cpu usar primeiro.
  let protocolo = gravador.protocoloGerenciamento;
  if (!protocolo || protocolo === "nenhum") {
    protocolo = await detectarProtocoloGerenciamento(gravador);
    await atualizarProtocoloGravador(gravador.id, protocolo).catch(() => undefined);
  }

  // --- Disco: tenta na ordem ISAPI -> Dahua CGI -> SNMP generico ---
  const erros: string[] = [];
  try {
    if (protocolo === "isapi") {
      resultado.discos = await obterStatusDiscos(gravador);
      resultado.origemDisco = "isapi";
    } else if (protocolo === "dahua_cgi") {
      resultado.discos = await obterStatusDiscosDahua(gravador);
      resultado.origemDisco = "dahua_cgi";
    } else {
      throw new Error("Nenhum protocolo de gerenciamento (ISAPI/CGI Dahua) detectado neste gravador");
    }
  } catch (e: any) {
    erros.push(e.message || String(e));
    // Ultimo recurso: SNMP generico, se estiver habilitado para este gravador
    if (gravador.snmp.ativo) {
      try {
        resultado.discos = await obterStatusDiscosSnmp(gravador);
        resultado.origemDisco = "snmp";
      } catch (e2: any) {
        erros.push(e2.message || String(e2));
      }
    }
  }
  if (resultado.discos.length === 0) {
    resultado.erroDisco = erros.join(" | ");
  }

  // --- CPU/memoria: so ISAPI por enquanto ---
  if (protocolo === "isapi") {
    try {
      const cpuMem = await obterCpuMemoria(gravador);
      resultado.cpuPercent = cpuMem.cpuPercent;
      resultado.memoriaUsadaMb = cpuMem.memoriaUsadaMb;
      resultado.memoriaTotalMb = cpuMem.memoriaTotalMb;
    } catch (e: any) {
      resultado.erroCpuMemoria = e.message || String(e);
    }
  } else {
    resultado.erroCpuMemoria = `CPU/memória ainda não suportado para protocolo "${protocolo}"`;
  }

  // --- Rede: SNMP (IF-MIB), como ja estava ---
  if (gravador.snmp.ativo) {
    try {
      const rede = await obterConsumoRede(gravador);
      resultado.redeEntradaMbps = rede.entradaMbps;
      resultado.redeSaidaMbps = rede.saidaMbps;
    } catch (e: any) {
      resultado.erroRede = e.message || String(e);
    }
  } else {
    resultado.erroRede = "SNMP desativado para este gravador";
  }

  return resultado;
}
