import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import {
  iniciarBanco,
  listarCameras,
  salvarCamera,
  salvarCamerasEmLote,
  removerCamera,
  listarGravadores,
  buscarGravadorPorId,
  salvarGravador,
  removerGravador,
  atualizarNivelChecagemGravador,
  atualizarSaudeGravador,
  obterConfiguracoes,
  salvarConfiguracoes,
  listarHistorico,
  listarEventosConectividade,
} from "./store";
import { executarAuditoria } from "./auditRunner";
import { corrigirHorarioEmLote } from "./timeSyncRunner";
import { enviarRelatorioCentral } from "./relatorioCentral";
import { definirAuditoriaEmAndamento, isAuditoriaEmAndamento } from "./estadoAuditoria";
import { executarHeartbeatIndividuais, executarHeartbeatGravador } from "./heartbeatRunner";
import { reconfigurarAgendamento } from "./scheduler";
import { TelegramNotifier } from "./notifiers";
import { conectar, descobrirCanais } from "./onvifClient";
import { coletarSaudeGravador } from "./saudeGravador";
import { Camera, Gravador } from "./types";

let janelaPrincipal: BrowserWindow | null = null;
let intervaloIndividuais: NodeJS.Timeout | null = null;
let intervaloServidorCentral: NodeJS.Timeout | null = null;
const temporizadoresGravadores = new Map<string, NodeJS.Timeout>();

function criarJanela() {
  janelaPrincipal = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Auditoria CFTV",
    icon: path.join(__dirname, "../../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  janelaPrincipal.loadFile(path.join(__dirname, "../../src/renderer/index.html"));
}

// ---------------------------------------------------------------------
// Heartbeat: cameras individuais (loop unico, rapido, independente da
// quantidade de cameras -- TCP puro e barato mesmo em escala).
// ---------------------------------------------------------------------
function iniciarHeartbeatIndividuais() {
  if (intervaloIndividuais) clearInterval(intervaloIndividuais);

  const rodarCiclo = async () => {
    if (isAuditoriaEmAndamento()) return; // heartbeat pausado durante a auditoria manual
    try {
      const resultados = await executarHeartbeatIndividuais();
      if (resultados.length > 0) {
        janelaPrincipal?.webContents.send("heartbeat:atualizado", resultados);
      }
    } catch (e) {
      console.error("[heartbeat individuais] Erro no ciclo:", e);
    }
  };

  rodarCiclo();
  const intervalo = obterConfiguracoes().heartbeat.intervaloRapidoMs;
  intervaloIndividuais = setInterval(rodarCiclo, intervalo);
}

// ---------------------------------------------------------------------
// Envio periodico de resumo para o servidor central (opcional, so roda se
// configurado). E so um resumo leve -- nao precisa da mesma cadencia do
// heartbeat de conectividade.
// ---------------------------------------------------------------------
function iniciarEnvioServidorCentral() {
  if (intervaloServidorCentral) clearInterval(intervaloServidorCentral);

  const config = obterConfiguracoes();
  if (!config.servidorCentral.ativo) return;

  const rodarCiclo = async () => {
    try {
      await enviarRelatorioCentral(obterConfiguracoes().servidorCentral);
    } catch (e) {
      console.error("[servidor central] Falha ao enviar relatorio:", e);
    }
  };

  rodarCiclo();
  intervaloServidorCentral = setInterval(rodarCiclo, config.servidorCentral.intervaloEnvioMs);
}

// ---------------------------------------------------------------------
// Heartbeat: gravadores -- cada gravador tem seu PROPRIO temporizador,
// rodando em paralelo com os demais (nao serializado), e o intervalo se
// ajusta sozinho conforme a camada de checagem usada naquele gravador:
// rapido para ISAPI, lento para o fallback ONVIF-por-canal / TCP-gravador.
// ---------------------------------------------------------------------
async function cicloGravador(gravador: Gravador) {
  if (isAuditoriaEmAndamento()) {
    // Nao faz trabalho agora, mas reagenda uma nova checagem em breve --
    // assim que a auditoria terminar, o heartbeat retoma sozinho.
    const timer = setTimeout(() => cicloGravador(gravador), 2000);
    temporizadoresGravadores.set(gravador.id, timer);
    return;
  }

  try {
    const { resultados, nivel } = await executarHeartbeatGravador(gravador);
    await atualizarNivelChecagemGravador(gravador.id, nivel);
    if (resultados.length > 0) {
      janelaPrincipal?.webContents.send("heartbeat:atualizado", resultados);
    }
    janelaPrincipal?.webContents.send("heartbeat:nivelGravadorAtualizado", { gravadorId: gravador.id, nivel });

    const config = obterConfiguracoes();
    const proximoIntervalo =
      nivel === "isapi" ? config.heartbeat.intervaloRapidoMs : config.heartbeat.intervaloLentoMs;

    const timer = setTimeout(() => cicloGravador(gravador), proximoIntervalo);
    temporizadoresGravadores.set(gravador.id, timer);
  } catch (e) {
    console.error(`[heartbeat gravador ${gravador.nome}] Erro no ciclo:`, e);
    // mesmo em erro inesperado, tenta de novo no intervalo lento (evita loop de erro em alta frequencia)
    const config = obterConfiguracoes();
    const timer = setTimeout(() => cicloGravador(gravador), config.heartbeat.intervaloLentoMs);
    temporizadoresGravadores.set(gravador.id, timer);
  }
}

function iniciarHeartbeatGravador(gravador: Gravador) {
  pararHeartbeatGravador(gravador.id); // evita duplicar timer se ja existir um rodando
  cicloGravador(gravador); // roda o primeiro ciclo imediatamente; os seguintes se auto-agendam
}

function pararHeartbeatGravador(gravadorId: string) {
  const timer = temporizadoresGravadores.get(gravadorId);
  if (timer) {
    clearTimeout(timer);
    temporizadoresGravadores.delete(gravadorId);
  }
}

function pararTodosHeartbeatsGravadores() {
  temporizadoresGravadores.forEach((timer) => clearTimeout(timer));
  temporizadoresGravadores.clear();
}

app.whenReady().then(async () => {
  await iniciarBanco();
  reconfigurarAgendamento(obterConfiguracoes(), () => {
    janelaPrincipal?.webContents.send("execucao-agendada-concluida");
  });

  criarJanela();

  // Conectividade automatica: cameras individuais (loop unico rapido) +
  // um temporizador independente por gravador (paralelo, intervalo adaptativo)
  iniciarHeartbeatIndividuais();
  iniciarEnvioServidorCentral();
  listarGravadores()
    .filter((g) => g.ativo)
    .forEach((gravador) => iniciarHeartbeatGravador(gravador));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) criarJanela();
  });
});

app.on("window-all-closed", () => {
  if (intervaloIndividuais) clearInterval(intervaloIndividuais);
  if (intervaloServidorCentral) clearInterval(intervaloServidorCentral);
  pararTodosHeartbeatsGravadores();
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------
// IPC: Cameras individuais
// ---------------------------------------------------------------------
ipcMain.handle("cameras:listar", () => listarCameras());

ipcMain.handle("cameras:salvar", async (_evt, camera: Omit<Camera, "id" | "origem"> & { id?: string }) => {
  return salvarCamera({ ...camera, origem: "individual" });
});

ipcMain.handle("cameras:remover", async (_evt, id: string) => {
  await removerCamera(id);
  return true;
});

// ---------------------------------------------------------------------
// IPC: Gravadores (adicionar o NVR inteiro e descobrir os canais)
// ---------------------------------------------------------------------
ipcMain.handle("gravadores:listar", () => listarGravadores());

ipcMain.handle(
  "gravadores:adicionarEDescobrirCanais",
  async (_evt, dados: Omit<Gravador, "id" | "totalCanaisDescobertos">) => {
    const cam = await conectar({
      ip: dados.ip,
      portaOnvif: dados.portaOnvif,
      usuario: dados.usuario,
      senha: dados.senha,
    });

    const canais = await descobrirCanais(cam);
    if (canais.length === 0) {
      throw new Error("O gravador respondeu, mas nenhum canal/perfil foi encontrado via ONVIF.");
    }

    const gravador = await salvarGravador({ ...dados, totalCanaisDescobertos: canais.length });

    const novasCameras = await salvarCamerasEmLote(
      canais.map((canal) => ({
        nome: canal.nome || `${dados.nome} - Canal ${canal.canalNumero}`,
        ip: dados.ip,
        portaOnvif: dados.portaOnvif,
        usuario: dados.usuario,
        senha: dados.senha,
        marca: "",
        ativo: true,
        origem: "gravador" as const,
        gravadorId: gravador.id,
        canalToken: canal.token,
        canalNumero: canal.canalNumero,
        statusConectividade: "desconhecido" as const,
      }))
    );

    // Comeca o heartbeat desse gravador imediatamente, sem esperar reiniciar o app
    iniciarHeartbeatGravador(gravador);

    return { gravador, canais: novasCameras };
  }
);

ipcMain.handle("gravadores:remover", async (_evt, id: string) => {
  pararHeartbeatGravador(id);
  await removerGravador(id);
  return true;
});

ipcMain.handle("gravadores:testarSaude", async (_evt, id: string) => {
  const gravador = buscarGravadorPorId(id);
  if (!gravador) {
    throw new Error("Gravador não encontrado.");
  }
  const saude = await coletarSaudeGravador(gravador);
  await atualizarSaudeGravador(gravador.id, saude);
  return saude;
});

// ---------------------------------------------------------------------
// IPC: Configuracoes
// ---------------------------------------------------------------------
ipcMain.handle("config:obter", () => obterConfiguracoes());

ipcMain.handle("config:salvar", async (_evt, config) => {
  const salvo = await salvarConfiguracoes(config);
  reconfigurarAgendamento(salvo, () => {
    janelaPrincipal?.webContents.send("execucao-agendada-concluida");
  });
  // Reinicia os loops que dependem de configuracao (intervalo pode ter mudado)
  iniciarHeartbeatIndividuais();
  iniciarEnvioServidorCentral();
  return salvo;
});

ipcMain.handle("config:testarTelegram", async () => {
  const config = obterConfiguracoes();
  const notifier = new TelegramNotifier(config.telegram);
  if (!notifier.estaConfigurado()) {
    throw new Error("Preencha o token do bot e o chat id antes de testar.");
  }
  await notifier.enviarMensagem("✅ Teste de integração — Auditoria CFTV configurada com sucesso.");
  return true;
});

ipcMain.handle("config:testarServidorCentral", async () => {
  const config = obterConfiguracoes();
  await enviarRelatorioCentral(config.servidorCentral);
  return true;
});

// ---------------------------------------------------------------------
// IPC: Auditoria completa (manual) / Historico
// ---------------------------------------------------------------------
ipcMain.handle("auditoria:executarAgora", async (evt) => {
  const cameras = listarCameras();
  const config = obterConfiguracoes();

  definirAuditoriaEmAndamento(true);
  janelaPrincipal?.webContents.send("heartbeat:pausado", true);

  try {
    const execucao = await executarAuditoria(cameras, config, (resultado) => {
      evt.sender.send("auditoria:progresso", resultado);
    });
    return execucao;
  } finally {
    definirAuditoriaEmAndamento(false);
    janelaPrincipal?.webContents.send("heartbeat:pausado", false);
  }
});

ipcMain.handle("historico:listar", (_evt, limite?: number) => listarHistorico(limite));

// ---------------------------------------------------------------------
// IPC: Ajuste de horario em lote (envia o horario NTP direto pras cameras)
// ---------------------------------------------------------------------
ipcMain.handle("horario:corrigirEmLote", async (_evt, filtro: "todas" | "comDesvio") => {
  const cameras = listarCameras().filter((c) => c.ativo);
  const config = obterConfiguracoes();

  let alvo = cameras;
  if (filtro === "comDesvio") {
    const ultimaExecucao = listarHistorico(1)[0];
    if (!ultimaExecucao) {
      throw new Error("Ainda não há nenhuma auditoria completa executada — rode uma auditoria primeiro.");
    }
    const idsComDesvio = new Set(
      ultimaExecucao.resultados.filter((r) => r.horarioStatus === "DESVIO_DE_HORARIO").map((r) => r.cameraId)
    );
    alvo = cameras.filter((c) => idsComDesvio.has(c.id));
  }

  if (alvo.length === 0) {
    return [];
  }

  definirAuditoriaEmAndamento(true); // reaproveita a mesma pausa do heartbeat durante a correcao
  janelaPrincipal?.webContents.send("heartbeat:pausado", true);
  try {
    return await corrigirHorarioEmLote(alvo, config.ntpServer);
  } finally {
    definirAuditoriaEmAndamento(false);
    janelaPrincipal?.webContents.send("heartbeat:pausado", false);
  }
});

// ---------------------------------------------------------------------
// IPC: Heartbeat (conectividade continua, automatica)
// ---------------------------------------------------------------------
ipcMain.handle("heartbeat:eventos", (_evt, limite?: number) => listarEventosConectividade(limite));
