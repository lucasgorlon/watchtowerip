// @ts-ignore - digest-fetch nao possui tipos oficiais
import DigestFetch from "digest-fetch";
import * as snmp from "net-snmp";
import { DiscoGravador, Gravador, SaudeGravador } from "./types";
import { detectarProtocoloGerenciamento, obterStatusDiscosDahua } from "./protocoloGravador";
import { atualizarProtocoloGravador, atualizarInterfaceSnmpGravador } from "./store";

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
const OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2";
const OID_IF_TYPE = "1.3.6.1.2.1.2.2.1.3";
const OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8";
const IF_TYPE_SOFTWARE_LOOPBACK = 24;
const IF_OPER_STATUS_UP = 1;

const TIMEOUT_SNMP_MS = 4000;
const TENTATIVAS_SNMP = 1;

function criarSessaoSnmp(gravador: Gravador): snmp.Session {
  return snmp.createSession(gravador.ip, gravador.snmp.community, {
    port: gravador.snmp.porta,
    timeout: TIMEOUT_SNMP_MS,
    retries: TENTATIVAS_SNMP,
    version: snmp.Version2c,
  });
}

/**
 * Traduz o erro cru do net-snmp ("Request timed out") em algo acionavel.
 * No SNMP v2c, comunidade errada NAO gera erro -- o agente simplesmente
 * ignora o pacote -- entao timeout cobre as tres causas abaixo.
 */
function traduzirErroSnmp(erro: unknown, gravador: Gravador): Error {
  const e = erro as any;
  const ehTimeout = e?.name === "RequestTimedOutError" || /timed? ?out/i.test(String(e?.message ?? e));
  if (ehTimeout) {
    const segundos = Math.round((TIMEOUT_SNMP_MS * (TENTATIVAS_SNMP + 1)) / 1000);
    return new Error(
      `SNMP não respondeu em ${segundos}s (${gravador.ip}:${gravador.snmp.porta}/UDP). Causas prováveis: ` +
        `SNMP desligado no gravador, comunidade "${gravador.snmp.community}" incorreta (o gravador ignora em silêncio) ` +
        `ou UDP ${gravador.snmp.porta} bloqueado na VPN/firewall.`
    );
  }
  return erro instanceof Error ? erro : new Error(String(erro));
}

interface InterfaceRede {
  indice: number;
  nome: string;
  tipo: number | null;
  up: boolean;
  trafegoTotal: bigint;
}

function ehLoopback(iface: Pick<InterfaceRede, "nome" | "tipo">): boolean {
  return iface.tipo === IF_TYPE_SOFTWARE_LOOPBACK || /^lo\d*$|loopback/i.test(iface.nome.trim());
}

/**
 * Descobre qual interface (ifIndex) e a rede "de verdade" do gravador.
 * O indice 1 fixo nao serve: em muitos NVRs (Linux embarcado) o indice 1
 * e o loopback "lo", e a leitura dava sempre ~0 Mbps.
 *
 * Criterio: descarta loopback; prefere interface UP; entre elas, a de maior
 * trafego acumulado (ifInOctets + ifOutOctets); em empate, nomes tipo
 * eth0, eth1, enp... ou bond0 primeiro.
 */
async function descobrirInterfaceRede(sessao: snmp.Session): Promise<{ indice: number; nome: string }> {
  const [descrs, tipos, status, entradas, saidas] = await Promise.all([
    caminharSubarvore(sessao, OID_IF_DESCR),
    caminharSubarvore(sessao, OID_IF_TYPE).catch(() => []),
    caminharSubarvore(sessao, OID_IF_OPER_STATUS).catch(() => []),
    caminharSubarvore(sessao, OID_IF_IN_OCTETS).catch(() => []),
    caminharSubarvore(sessao, OID_IF_OUT_OCTETS).catch(() => []),
  ]);

  const porIndice = (varbinds: any[]) => {
    const mapa = new Map<number, any>();
    for (const vb of varbinds) {
      if (snmp.isVarbindError(vb)) continue;
      const partes = String(vb.oid).split(".");
      mapa.set(Number(partes[partes.length - 1]), vb.value);
    }
    return mapa;
  };
  const mapaDescr = porIndice(descrs);
  const mapaTipo = porIndice(tipos);
  const mapaStatus = porIndice(status);
  const mapaEntrada = porIndice(entradas);
  const mapaSaida = porIndice(saidas);

  const paraBigInt = (v: any) => {
    try {
      return v === undefined || v === null ? BigInt(0) : BigInt(v.toString());
    } catch {
      return BigInt(0);
    }
  };

  const interfaces: InterfaceRede[] = Array.from(mapaDescr.entries()).map(([indice, descr]) => ({
    indice,
    nome: Buffer.isBuffer(descr) ? descr.toString("utf8").replace(/\0/g, "") : String(descr),
    tipo: mapaTipo.has(indice) ? Number(mapaTipo.get(indice)) : null,
    up: Number(mapaStatus.get(indice)) === IF_OPER_STATUS_UP,
    trafegoTotal: paraBigInt(mapaEntrada.get(indice)) + paraBigInt(mapaSaida.get(indice)),
  }));

  const candidatas = interfaces.filter((i) => !ehLoopback(i));
  if (candidatas.length === 0) {
    const nomes = interfaces.map((i) => i.nome).join(", ") || "nenhuma";
    throw new Error(`SNMP respondeu, mas nenhuma interface de rede (fora o loopback) foi encontrada em ifDescr (interfaces: ${nomes}).`);
  }

  const pesoNome = (nome: string) => (/^eth0$/i.test(nome) ? 2 : /^(eth|en|bond)/i.test(nome) ? 1 : 0);
  candidatas.sort((a, b) => {
    if (a.up !== b.up) return a.up ? -1 : 1;
    if (a.trafegoTotal !== b.trafegoTotal) return a.trafegoTotal > b.trafegoTotal ? -1 : 1;
    return pesoNome(b.nome) - pesoNome(a.nome);
  });

  return { indice: candidatas[0].indice, nome: candidatas[0].nome };
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

function ehErroTimeoutSnmp(erro: unknown): boolean {
  const e = erro as any;
  return e?.name === "RequestTimedOutError" || /timed? ?out/i.test(String(e?.message ?? e));
}

/** Primeira amostra dos contadores: tenta 64 bits e cai para 32 bits se o agente nao suportar. */
async function lerPrimeiraAmostra(
  sessao: snmp.Session,
  idx: number
): Promise<{ amostra: [bigint, bigint]; oids: [string, string]; usar64Bits: boolean }> {
  const oids64: [string, string] = [`${OID_IF_HC_IN_OCTETS}.${idx}`, `${OID_IF_HC_OUT_OCTETS}.${idx}`];
  try {
    return { amostra: await lerContadores(sessao, oids64), oids: oids64, usar64Bits: true };
  } catch (e) {
    // Timeout nao e "64 bits nao suportado" -- nao adianta tentar de novo com 32 bits
    if (ehErroTimeoutSnmp(e)) throw e;
    const oids32: [string, string] = [`${OID_IF_IN_OCTETS}.${idx}`, `${OID_IF_OUT_OCTETS}.${idx}`];
    return { amostra: await lerContadores(sessao, oids32), oids: oids32, usar64Bits: false };
  }
}

export async function obterConsumoRede(
  gravador: Gravador,
  intervaloAmostraMs = 1000
): Promise<{ entradaMbps: number; saidaMbps: number; interfaceNome: string }> {
  const sessao = criarSessaoSnmp(gravador);

  try {
    // Usa a interface em cache; se nao houver (ou se o indice sumiu, ex.
    // apos reboot/troca de firmware), descobre de novo via ifDescr.
    let iface = gravador.snmpInterface;
    let usouCache = !!iface;
    if (!iface) {
      iface = await descobrirInterfaceRede(sessao);
      await atualizarInterfaceSnmpGravador(gravador.id, iface).catch(() => undefined);
    }

    let primeira: Awaited<ReturnType<typeof lerPrimeiraAmostra>>;
    try {
      primeira = await lerPrimeiraAmostra(sessao, iface.indice);
    } catch (e) {
      if (!usouCache || ehErroTimeoutSnmp(e)) throw e;
      // indice em cache nao existe mais (noSuchInstance) -- redescobre uma vez
      iface = await descobrirInterfaceRede(sessao);
      await atualizarInterfaceSnmpGravador(gravador.id, iface).catch(() => undefined);
      usouCache = false;
      primeira = await lerPrimeiraAmostra(sessao, iface.indice);
    }
    const { amostra: amostra1, oids: oidsEntradaSaida, usar64Bits } = primeira;

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
      interfaceNome: iface.nome,
    };
  } catch (e) {
    throw traduzirErroSnmp(e, gravador);
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
  } catch (e) {
    throw traduzirErroSnmp(e, gravador);
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
      resultado.redeInterface = rede.interfaceNome;
    } catch (e: any) {
      resultado.erroRede = e.message || String(e);
    }
  } else {
    resultado.erroRede = "SNMP desativado para este gravador";
  }

  return resultado;
}
