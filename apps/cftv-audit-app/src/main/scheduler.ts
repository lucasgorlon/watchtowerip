import cron, { ScheduledTask } from "node-cron";
import { Configuracoes } from "./types";
import { listarCameras } from "./store";
import { executarAuditoria } from "./auditRunner";

let tarefaAtual: ScheduledTask | null = null;

/** (Re)inicia o agendamento com base na configuracao atual. Chame sempre que a config mudar. */
export function reconfigurarAgendamento(config: Configuracoes, onExecucaoAgendada?: () => void) {
  if (tarefaAtual) {
    tarefaAtual.stop();
    tarefaAtual = null;
  }

  if (!config.agendamentoAtivo) {
    return;
  }

  if (!cron.validate(config.agendamentoCron)) {
    console.error(`[scheduler] Expressao cron invalida: "${config.agendamentoCron}" — agendamento desativado.`);
    return;
  }

  tarefaAtual = cron.schedule(config.agendamentoCron, async () => {
    console.log("[scheduler] Disparando auditoria agendada...");
    try {
      const cameras = listarCameras();
      await executarAuditoria(cameras, config);
      onExecucaoAgendada?.();
    } catch (e) {
      console.error("[scheduler] Erro na auditoria agendada:", e);
    }
  });

  console.log(`[scheduler] Agendamento ativo: "${config.agendamentoCron}"`);
}
