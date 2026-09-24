import { ConfigServidorCentral, ResumoRelatorioCentral } from "./types";
import { listarCameras, listarHistorico, listarGravadores, atualizarSaudeGravador } from "./store";
import { coletarSaudeGravador } from "./saudeGravador";

/** Monta o resumo atual (conectividade + ultima auditoria + saude dos gravadores). */
export async function construirResumoAtual(): Promise<ResumoRelatorioCentral> {
  const cameras = listarCameras().filter((c) => c.ativo);
  const online = cameras.filter((c) => c.statusConectividade === "online").length;
  const offline = cameras.filter((c) => c.statusConectividade === "offline").length;
  const desconhecido = cameras.length - online - offline;

  const ultimaExecucao = listarHistorico(1)[0];

  const gravadores = listarGravadores().filter((g) => g.ativo);
  const saudeGravadores = await Promise.all(
    gravadores.map(async (gravador) => {
      try {
        const saude = await coletarSaudeGravador(gravador);
        await atualizarSaudeGravador(gravador.id, saude);

        const discoTotalGb = saude.discos.reduce((soma, d) => soma + d.capacidadeGb, 0);
        const discoLivreGb = saude.discos.reduce((soma, d) => soma + d.livreGb, 0);
        const redeMbps =
          saude.redeEntradaMbps !== null && saude.redeSaidaMbps !== null
            ? Math.round((saude.redeEntradaMbps + saude.redeSaidaMbps) * 100) / 100
            : undefined;

        return {
          gravadorId: gravador.id,
          nome: gravador.nome,
          discoTotalGb: saude.discos.length > 0 ? Math.round(discoTotalGb * 10) / 10 : undefined,
          discoLivreGb: saude.discos.length > 0 ? Math.round(discoLivreGb * 10) / 10 : undefined,
          redeMbps,
        };
      } catch (e) {
        // Falha ao coletar saude de um gravador nao deve derrubar o relatorio inteiro
        console.error(`[relatorioCentral] Falha ao coletar saude de ${gravador.nome}:`, e);
        return { gravadorId: gravador.id, nome: gravador.nome };
      }
    })
  );

  return {
    totalCameras: cameras.length,
    online,
    offline,
    desconhecido,
    ultimaAuditoria: ultimaExecucao
      ? {
          dataHoraFim: ultimaExecucao.dataHoraFim,
          ok: ultimaExecucao.ok,
          atencao: ultimaExecucao.atencao,
          offline: ultimaExecucao.offline,
          manual: ultimaExecucao.manual,
        }
      : null,
    saudeGravadores,
  };
}

/** Envia o resumo atual para o servidor central configurado. Lanca erro em caso de falha. */
export async function enviarRelatorioCentral(config: ConfigServidorCentral): Promise<void> {
  if (!config.ativo) {
    throw new Error("Envio ao servidor central está desativado nas configurações.");
  }
  if (!config.url || !config.apiKey) {
    throw new Error("Preencha a URL e a API key do servidor central antes de testar/enviar.");
  }

  const resumo = await construirResumoAtual();
  const url = `${config.url.replace(/\/+$/, "")}/api/relatorios`;

  const resposta = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.apiKey,
    },
    body: JSON.stringify(resumo),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => "");
    throw new Error(`Servidor central respondeu HTTP ${resposta.status}: ${corpo || "sem detalhes"}`);
  }
}
