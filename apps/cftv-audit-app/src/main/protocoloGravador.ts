// @ts-ignore - digest-fetch nao possui tipos oficiais
import DigestFetch from "digest-fetch";
import { Gravador, ProtocoloGerenciamento, DiscoGravador } from "./types";

/**
 * Detecta qual protocolo de gerenciamento HTTP o gravador fala, alem do
 * ONVIF (que ja usamos para canais/horario). Tenta na ordem:
 *   1) ISAPI (familia Hikvision -- inclui boa parte da linha Intelbras)
 *   2) CGI Dahua (magicBox.cgi -- a outra familia de OEM que a Intelbras usa)
 * Se nenhum responder, marca "nenhum" -- nesse caso so sobra o fallback via
 * SNMP generico (HOST-RESOURCES-MIB) para disco, sem CPU/memoria.
 *
 * O resultado fica em cache no proprio gravador (Gravador.protocoloGerenciamento)
 * para nao reprobar isso a cada coleta -- so reprobamos quando o cache diz
 * "nenhum" (permite que o gravador "va melhorando" apos um update de firmware
 * sem precisar remover e recadastrar) ou quando o usuario pede manualmente.
 */
export async function detectarProtocoloGerenciamento(gravador: Gravador): Promise<ProtocoloGerenciamento> {
  const client = new DigestFetch(gravador.usuario, gravador.senha);
  const base = `http://${gravador.ip}:${gravador.portaOnvif}`;

  try {
    const respIsapi = await client.fetch(`${base}/ISAPI/System/deviceInfo`, { method: "GET" });
    if (respIsapi.ok) return "isapi";
  } catch {
    /* segue para a proxima tentativa */
  }

  try {
    const respDahua = await client.fetch(`${base}/cgi-bin/magicBox.cgi?action=getVendor`, { method: "GET" });
    if (respDahua.ok) {
      const texto = await respDahua.text();
      if (/vendor=/i.test(texto)) return "dahua_cgi";
    }
  } catch {
    /* nenhum dos dois respondeu */
  }

  return "nenhum";
}

/**
 * Disco via CGI Dahua/Intelbras -- /cgi-bin/magicBox.cgi?action=getDeviceAllInfo
 * Resposta e texto plano chave=valor (nao XML), formato documentado:
 *   list[0].Detail[0].TotalBytes=...
 *   list[0].Detail[0].UsedBytes=...
 *   list[0].State=Success
 * Uma NVR pode ter mais de um "list[N]" (um por HDD fisico).
 */
export async function obterStatusDiscosDahua(gravador: Gravador): Promise<DiscoGravador[]> {
  const client = new DigestFetch(gravador.usuario, gravador.senha);
  const url = `http://${gravador.ip}:${gravador.portaOnvif}/cgi-bin/magicBox.cgi?action=getDeviceAllInfo`;

  const resp = await client.fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`CGI Dahua (getDeviceAllInfo) respondeu HTTP ${resp.status}`);
  }
  const texto = await resp.text();
  return extrairDiscosDoTextoDahua(texto);
}

function extrairDiscosDoTextoDahua(texto: string): DiscoGravador[] {
  // Agrupa linhas por indice de lista: list[0]..., list[1]..., etc.
  const porIndice = new Map<string, Record<string, string>>();
  const linhas = texto.split(/\r?\n/);

  for (const linha of linhas) {
    const m = linha.match(/^list\[(\d+)\]\.(\S+)=(.*)$/);
    if (!m) continue;
    const [, indice, campo, valor] = m;
    if (!porIndice.has(indice)) porIndice.set(indice, {});
    porIndice.get(indice)![campo] = valor.trim();
  }

  if (porIndice.size === 0) {
    throw new Error("Resposta do CGI Dahua nao contem nenhum 'list[N]' reconhecivel");
  }

  const discos: DiscoGravador[] = [];
  porIndice.forEach((campos, indice) => {
    // Os campos de tamanho ficam em "Detail[0].TotalBytes" / "Detail[0].UsedBytes"
    const totalKey = Object.keys(campos).find((k) => /Detail\[\d+\]\.TotalBytes/.test(k));
    const usadoKey = Object.keys(campos).find((k) => /Detail\[\d+\]\.UsedBytes/.test(k));
    const totalBytes = totalKey ? Number(campos[totalKey]) : 0;
    const usadoBytes = usadoKey ? Number(campos[usadoKey]) : 0;

    if (!totalBytes) return; // slot vazio/sem HDD fisico

    const capacidadeGb = Math.round((totalBytes / 1024 ** 3) * 10) / 10;
    const livreGb = Math.round(((totalBytes - usadoBytes) / 1024 ** 3) * 10) / 10;

    discos.push({
      id: indice,
      nome: `HDD ${indice}`,
      status: campos["State"] || "desconhecido",
      capacidadeGb,
      livreGb,
    });
  });

  if (discos.length === 0) {
    throw new Error("Nenhum HDD com tamanho valido encontrado na resposta do CGI Dahua");
  }

  return discos;
}
