import { randomUUID } from "crypto";
import { Camera, Configuracoes, ExecucaoAuditoria, ResultadoCamera, StatusCamera } from "./types";
import { conectar, verificarHorario, obterSnapshot } from "./onvifClient";
import { analisarImagem } from "./imageAnalysis";
import { obterHorarioReferencia } from "./ntp";
import { notificarTodos } from "./notifiers";
import { adicionarExecucao, buscarGravadorPorId } from "./store";

async function auditarCamera(
  camera: Camera,
  refUtc: Date,
  config: Configuracoes
): Promise<ResultadoCamera> {
  const base: ResultadoCamera = {
    cameraId: camera.id,
    nome: camera.nome,
    ip: camera.ip,
    canalNumero: camera.canalNumero ?? null,
    gravadorId: camera.gravadorId ?? null,
    statusGeral: "OFFLINE",
    horarioStatus: "NAO_VERIFICADO",
    desvioSegundos: null,
    imagemStatus: "NAO_VERIFICADO",
    nitidezValor: null,
    brilhoValor: null,
    erro: null,
  };

  const { verificarHorario: deveVerificarHorario, verificarImagem: deveVerificarImagem } = config.filtrosAuditoria;

  if (!deveVerificarHorario && !deveVerificarImagem) {
    // Nada selecionado para verificar -- nao ha motivo pra sequer conectar na camera
    base.statusGeral = "OK";
    return base;
  }

  let cam;
  try {
    cam = await conectar(camera);
  } catch (e: any) {
    base.erro = `Falha de conexao ONVIF: ${e.message || e}`;
    base.statusGeral = "OFFLINE";
    return base;
  }

  // Comeca neutro (true): se o filtro estiver desligado, essa checagem nao
  // deve contar contra o status geral da camera -- so os filtros ativos
  // participam da decisao final.
  let horarioOk = true;
  if (deveVerificarHorario) {
    horarioOk = false;
    try {
      const resultadoHorario = await verificarHorario(cam, refUtc, config.limites.desvioHorarioSegundos);
      base.horarioStatus = resultadoHorario.status;
      base.desvioSegundos = resultadoHorario.desvioSegundos;
      horarioOk = resultadoHorario.status === "OK";
    } catch (e: any) {
      base.horarioStatus = `ERRO: ${e.message || e}`;
    }
  }

  let imagemOk = true;
  if (deveVerificarImagem) {
    imagemOk = false;
    try {
      const jpeg = await obterSnapshot(cam, camera);
      const resultadoImagem = await analisarImagem(jpeg, config.limites);
      base.imagemStatus = resultadoImagem.status;
      base.nitidezValor = resultadoImagem.nitidez;
      base.brilhoValor = resultadoImagem.brilho;
      imagemOk = resultadoImagem.status === "OK";
    } catch (e: any) {
      base.imagemStatus = `ERRO: ${e.message || e}`;
    }
  }

  let status: StatusCamera;
  if (base.horarioStatus.startsWith("ERRO") || base.imagemStatus.startsWith("ERRO")) {
    status = "VERIFICAR_MANUALMENTE";
  } else if (horarioOk && imagemOk) {
    status = "OK";
  } else {
    status = "ATENCAO";
  }
  base.statusGeral = status;

  return base;
}

/** Roda a auditoria em todas as cameras ativas, com paralelismo limitado. */
export async function executarAuditoria(
  cameras: Camera[],
  config: Configuracoes,
  onProgresso?: (resultado: ResultadoCamera) => void,
  paralelismo = 6
): Promise<ExecucaoAuditoria> {
  const inicio = new Date();
  const ativas = cameras.filter((c) => c.ativo);

  let refUtc: Date;
  try {
    refUtc = await obterHorarioReferencia(config.ntpServer);
  } catch (e) {
    console.warn("[auditRunner] Falha ao obter NTP, usando horario local do sistema:", e);
    refUtc = new Date();
  }

  const resultados: ResultadoCamera[] = [];
  const fila = [...ativas];

  async function worker() {
    while (fila.length > 0) {
      const camera = fila.shift();
      if (!camera) break;
      const resultado = await auditarCamera(camera, refUtc, config);
      resultados.push(resultado);
      onProgresso?.(resultado);
    }
  }

  const workers = Array.from({ length: Math.min(paralelismo, ativas.length || 1) }, () => worker());
  await Promise.all(workers);

  const fim = new Date();
  const execucao: ExecucaoAuditoria = {
    id: randomUUID(),
    dataHoraInicio: inicio.toISOString(),
    dataHoraFim: fim.toISOString(),
    totalCameras: resultados.length,
    ok: resultados.filter((r) => r.statusGeral === "OK").length,
    atencao: resultados.filter((r) => r.statusGeral === "ATENCAO").length,
    offline: resultados.filter((r) => r.statusGeral === "OFFLINE").length,
    manual: resultados.filter((r) => r.statusGeral === "VERIFICAR_MANUALMENTE").length,
    resultados,
  };

  await adicionarExecucao(execucao);
  await enviarResumoNotificacao(execucao, config);

  return execucao;
}

async function enviarResumoNotificacao(execucao: ExecucaoAuditoria, config: Configuracoes) {
  const problematicas = execucao.resultados.filter((r) => r.statusGeral !== "OK");
  if (problematicas.length === 0) {
    return; // por padrao, so notifica quando ha algo fora do OK
  }

  const linhas = problematicas
    .slice(0, 30) // evita mensagem gigante no Telegram
    .map((r) => {
      const motivos = [
        r.horarioStatus !== "OK" ? `horario: ${r.horarioStatus}` : null,
        r.imagemStatus !== "OK" ? `imagem: ${r.imagemStatus}` : null,
        r.erro ? `erro: ${r.erro}` : null,
      ]
        .filter(Boolean)
        .join(" | ");

      // Quando a camera veio de um gravador, o IP sozinho nao ajuda a achar
      // o canal certo entre dezenas/centenas de outros no mesmo NVR -- por
      // isso o numero do canal (e o nome do gravador, se disponivel) entram
      // explicitamente na linha, alem do que o proprio ONVIF chamou a camera
      // (que em alguns gravadores e so um nome generico tipo "Profilename026").
      let origem = `(${r.ip})`;
      if (r.canalNumero !== null) {
        const gravador = r.gravadorId ? buscarGravadorPorId(r.gravadorId) : null;
        origem = `(${r.ip} — ${gravador ? gravador.nome : "gravador"}, Canal ${r.canalNumero})`;
      }

      return `• <b>${r.nome}</b> ${origem}: ${r.statusGeral} — ${motivos}`;
    })
    .join("\n");

  const mensagem =
    `<b>Auditoria CFTV concluida</b>\n` +
    `Total: ${execucao.totalCameras} | OK: ${execucao.ok} | Atencao: ${execucao.atencao} | ` +
    `Offline: ${execucao.offline} | Manual: ${execucao.manual}\n\n` +
    `${linhas}` +
    (problematicas.length > 30 ? `\n...e mais ${problematicas.length - 30} camera(s).` : "");

  await notificarTodos(config, mensagem);
}
