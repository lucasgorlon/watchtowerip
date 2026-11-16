// ---------------------------------------------------------------------
// Navegacao entre abas
// ---------------------------------------------------------------------
const abas = ["dashboard", "gravadores", "cameras", "config", "historico"];

function irParaAba(nome) {
  abas.forEach((a) => {
    document.getElementById(`tab-${a}`).classList.toggle("hidden", a !== nome);
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === nome);
  });
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    irParaAba(btn.dataset.tab);
    if (btn.dataset.tab === "gravadores") carregarGravadores();
    if (btn.dataset.tab === "cameras") carregarCameras();
    if (btn.dataset.tab === "config") carregarConfiguracoes();
    if (btn.dataset.tab === "historico") carregarHistorico();
  });
});

// ---------------------------------------------------------------------
// Dashboard / execucao de auditoria
// ---------------------------------------------------------------------
function pillStatus(status) {
  return `<span class="status-pill status-${status}">${status.replace("_", " ")}</span>`;
}

function renderizarResultados(resultados) {
  const tbody = document.querySelector("#tabela-resultados tbody");
  tbody.innerHTML = resultados
    .map(
      (r) => `
      <tr>
        <td>${r.nome}</td>
        <td>${r.ip}</td>
        <td>${r.canalNumero !== null && r.canalNumero !== undefined ? r.canalNumero : "-"}</td>
        <td>${pillStatus(r.statusGeral)}</td>
        <td>${r.horarioStatus}${r.desvioSegundos !== null ? ` (${r.desvioSegundos}s)` : ""}</td>
        <td>${r.imagemStatus}</td>
        <td>${r.erro || "-"}</td>
      </tr>`
    )
    .join("");
}

function atualizarResumo(execucao) {
  document.getElementById("resumo-ok").textContent = execucao.ok;
  document.getElementById("resumo-atencao").textContent = execucao.atencao;
  document.getElementById("resumo-offline").textContent = execucao.offline;
  document.getElementById("resumo-manual").textContent = execucao.manual;
}

let removerListenerProgresso = null;

document.getElementById("btn-executar-agora").addEventListener("click", async () => {
  const botao = document.getElementById("btn-executar-agora");
  const progresso = document.getElementById("progresso-execucao");
  const contador = document.getElementById("progresso-contador");

  botao.disabled = true;
  botao.textContent = "Executando...";
  progresso.classList.remove("hidden");
  contador.textContent = "0";

  let contagem = 0;
  const resultadosParciais = [];
  removerListenerProgresso?.();
  removerListenerProgresso = window.cftvApi.auditoria.aoProgresso((resultado) => {
    contagem++;
    contador.textContent = String(contagem);
    resultadosParciais.push(resultado);
    renderizarResultados(resultadosParciais);
  });

  try {
    const execucao = await window.cftvApi.auditoria.executarAgora();
    atualizarResumo(execucao);
    renderizarResultados(execucao.resultados);
  } catch (e) {
    alert("Erro ao executar auditoria: " + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = "▶ Executar auditoria agora";
    progresso.classList.add("hidden");
    removerListenerProgresso?.();
  }
});

window.cftvApi.auditoria.aoConcluirAgendada(async () => {
  const historico = await window.cftvApi.historico.listar(1);
  if (historico[0]) {
    atualizarResumo(historico[0]);
    renderizarResultados(historico[0].resultados);
  }
});

window.cftvApi.heartbeat.aoPausar((pausado) => {
  document.getElementById("heartbeat-pausado-aviso").classList.toggle("hidden", !pausado);
});

async function carregarUltimaExecucao() {
  const historico = await window.cftvApi.historico.listar(1);
  if (historico[0]) {
    atualizarResumo(historico[0]);
    renderizarResultados(historico[0].resultados);
  }
}

// ---------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------
const ORIGEM_CHECAGEM_LABEL = {
  isapi: "verificado via ISAPI (gravador)",
  tcp_individual: "verificado via TCP (câmera individual)",
  onvif_canal_individual: "verificado via ONVIF por canal (snapshot)",
  tcp_gravador_fallback: "verificado via TCP no gravador (não distingue canal)",
};

function pillConectividade(status, origem) {
  const s = status || "desconhecido";
  const rotulo = s === "online" ? "Online" : s === "offline" ? "Offline" : "Aguardando";
  const titulo = origem && ORIGEM_CHECAGEM_LABEL[origem] ? ` title="${ORIGEM_CHECAGEM_LABEL[origem]}"` : "";
  return `<span class="conect-${s}"${titulo}><span class="bolinha bolinha-${s}"></span>${rotulo}</span>`;
}

async function carregarCameras() {
  const cameras = await window.cftvApi.cameras.listar();
  const tbody = document.querySelector("#tabela-cameras tbody");
  tbody.innerHTML = cameras
    .map(
      (c) => `
      <tr data-camera-id="${c.id}">
        <td>${c.nome}</td>
        <td>${c.ip}</td>
        <td>${c.origem === "gravador" ? `Gravador (canal ${c.canalNumero})` : "Individual"}</td>
        <td class="celula-conectividade">${pillConectividade(c.statusConectividade, c.origemUltimaChecagem)}</td>
        <td>${c.ativo ? "Sim" : "Não"}</td>
        <td>
          ${c.origem === "individual" ? `<button class="btn-link" data-editar="${c.id}">Editar</button>` : ""}
          <button class="btn-danger-link" data-remover="${c.id}">Remover</button>
        </td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-editar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const camera = cameras.find((c) => c.id === btn.dataset.editar);
      abrirModalCamera(camera);
    });
  });
  tbody.querySelectorAll("[data-remover]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const camera = cameras.find((c) => c.id === btn.dataset.remover);
      const aviso =
        camera?.origem === "gravador"
          ? "Esta câmera veio de um gravador. Remover aqui só apaga este canal individualmente (para remover todos de uma vez, apague o gravador na aba Gravadores). Continuar?"
          : "Remover esta câmera?";
      if (confirm(aviso)) {
        await window.cftvApi.cameras.remover(btn.dataset.remover);
        carregarCameras();
      }
    });
  });
}

// ---------------------------------------------------------------------
// Gravadores
// ---------------------------------------------------------------------
const NIVEL_CHECAGEM_LABEL = {
  isapi: "ISAPI (rápido)",
  onvif_canal: "ONVIF por canal (lento)",
  tcp_fallback: "TCP no gravador (lento)",
  pausado_autenticacao: "🔒 Pausado: credenciais recusadas (só TCP, sem login)",
  desconhecido: "Ainda não verificado",
};

function escaparAtributo(texto) {
  return String(texto || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const ORIGEM_DISCO_LABEL = { isapi: "ISAPI", dahua_cgi: "CGI Dahua", snmp: "SNMP" };

function formatarSaude(saude) {
  if (!saude) return '<span class="hint">Ainda não coletado</span>';

  const partes = [];
  if (saude.discos && saude.discos.length > 0) {
    const totalLivre = saude.discos.reduce((s, d) => s + d.livreGb, 0);
    const totalCap = saude.discos.reduce((s, d) => s + d.capacidadeGb, 0);
    const pctLivre = totalCap > 0 ? Math.round((totalLivre / totalCap) * 100) : 0;
    const origem = ORIGEM_DISCO_LABEL[saude.origemDisco] || "";
    partes.push(`💾 ${totalLivre.toFixed(0)}/${totalCap.toFixed(0)}GB livre (${pctLivre}%)${origem ? ` [${origem}]` : ""}`);
  } else if (saude.erroDisco) {
    partes.push(`💾 <span class="conect-offline" title="${saude.erroDisco.replace(/"/g, "&quot;")}">indisponível ⓘ</span>`);
  }

  if (saude.cpuPercent !== null && saude.cpuPercent !== undefined) {
    partes.push(`🖥️ CPU ${saude.cpuPercent}%`);
  }

  if (saude.redeEntradaMbps !== null && saude.redeEntradaMbps !== undefined) {
    const iface = saude.redeInterface ? ` [${escaparAtributo(saude.redeInterface)}]` : "";
    partes.push(`📶 ${saude.redeEntradaMbps}↓/${saude.redeSaidaMbps}↑ Mbps${iface}`);
  } else if (saude.erroRede) {
    partes.push(`📶 <span class="conect-offline" title="${escaparAtributo(saude.erroRede)}">rede n/d ⓘ</span>`);
  }

  const rodape = `<div class="hint">Coletado em ${new Date(saude.coletadoEm).toLocaleTimeString("pt-BR")}</div>`;
  return partes.join(" &nbsp;•&nbsp; ") + rodape;
}

async function carregarGravadores() {
  const [gravadores, config] = await Promise.all([
    window.cftvApi.gravadores.listar(),
    window.cftvApi.config.obter(),
  ]);
  const tbody = document.querySelector("#tabela-gravadores tbody");
  tbody.innerHTML = gravadores
    .map((g) => {
      const nivel = g.nivelChecagemAtual || "desconhecido";
      const intervaloMs = nivel === "isapi" ? config.heartbeat.intervaloRapidoMs : config.heartbeat.intervaloLentoMs;
      const intervaloTexto = nivel === "desconhecido" ? "" : ` (a cada ${(intervaloMs / 1000).toFixed(0)}s)`;
      const avisoPausa = g.pausadoPorAutenticacao
        ? `<div class="conect-offline" title="${escaparAtributo(g.motivoPausa)}">Login pausado ⓘ</div>`
        : g.falhasAutenticacaoConsecutivas > 0
        ? `<div class="hint">${g.falhasAutenticacaoConsecutivas} falha(s) de login seguida(s)</div>`
        : "";
      const botaoRetomar = g.pausadoPorAutenticacao
        ? `<button class="btn-link" data-retomar-gravador="${g.id}">Retomar (corrigir senha)</button><br/>`
        : "";
      return `
      <tr data-gravador-id="${g.id}">
        <td>${g.nome}</td>
        <td>${g.ip}</td>
        <td>${g.totalCanaisDescobertos}</td>
        <td>${
          g.suportaIsapi === true
            ? '<span class="conect-online">Suportado</span>'
            : g.suportaIsapi === false
            ? `<span class="conect-offline" title="${(g.ultimoErroIsapi || "").replace(/"/g, "&quot;")}">Não suportado (usando fallback) ⓘ</span>`
            : "Ainda não verificado"
        }</td>
        <td class="celula-nivel-checagem">${NIVEL_CHECAGEM_LABEL[nivel] || nivel}${intervaloTexto}${avisoPausa}</td>
        <td class="celula-saude">${formatarSaude(g.ultimaSaude)}</td>
        <td>
          ${botaoRetomar}
          <button class="btn-link" data-testar-saude="${g.id}">Testar saúde agora</button><br/>
          <button class="btn-danger-link" data-remover-gravador="${g.id}">Remover</button>
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-remover-gravador]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (confirm("Remover este gravador e TODOS os canais descobertos a partir dele?")) {
        await window.cftvApi.gravadores.remover(btn.dataset.removerGravador);
        carregarGravadores();
      }
    });
  });

  tbody.querySelectorAll("[data-retomar-gravador]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = gravadores.find((x) => x.id === btn.dataset.retomarGravador);
      if (!g) return;
      gravadorRetomarId = g.id;
      document.getElementById("retomar-motivo").textContent = g.motivoPausa || "";
      document.getElementById("retomar-usuario").value = g.usuario || "";
      document.getElementById("retomar-senha").value = "";
      document.getElementById("retomar-status-msg").textContent = "";
      document.getElementById("modal-retomar").classList.remove("hidden");
    });
  });

  tbody.querySelectorAll("[data-testar-saude]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.testarSaude;
      const celula = document.querySelector(`#tabela-gravadores tr[data-gravador-id="${id}"] .celula-saude`);
      const textoOriginal = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Coletando...";
      try {
        const saude = await window.cftvApi.gravadores.testarSaude(id);
        if (celula) celula.innerHTML = formatarSaude(saude);
      } catch (e) {
        alert("Falha ao coletar saúde: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    });
  });
}

let gravadorRetomarId = null;

document.getElementById("btn-cancelar-retomar").addEventListener("click", () => {
  document.getElementById("modal-retomar").classList.add("hidden");
});

document.getElementById("btn-confirmar-retomar").addEventListener("click", async (evt) => {
  const botao = evt.currentTarget;
  const msg = document.getElementById("retomar-status-msg");
  const usuario = document.getElementById("retomar-usuario").value.trim();
  const senha = document.getElementById("retomar-senha").value;
  if (!gravadorRetomarId) return;

  botao.disabled = true;
  botao.textContent = "Testando...";
  msg.textContent = "Testando porta, ONVIF e login (uma única tentativa)...";
  try {
    await window.cftvApi.gravadores.retomar(gravadorRetomarId, { usuario: usuario || undefined, senha: senha || undefined });
    msg.textContent = "✔ Login OK — monitoramento retomado.";
    setTimeout(() => {
      document.getElementById("modal-retomar").classList.add("hidden");
      carregarGravadores();
    }, 1000);
  } catch (e) {
    msg.textContent = "Continua pausado: " + limparErroIpc(e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = "Testar e retomar";
  }
});

/** Remove o prefixo "Error invoking remote method '...': Error: " que o Electron coloca em erros de IPC. */
function limparErroIpc(mensagem) {
  return String(mensagem || "").replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");
}

window.cftvApi.heartbeat.aoNivelGravadorAtualizar(({ gravadorId }) => {
  // Se a aba Gravadores estiver visivel, recarrega pra refletir o nivel/intervalo mais recente
  if (!document.getElementById("tab-gravadores").classList.contains("hidden")) {
    carregarGravadores();
  }
});

document.getElementById("btn-novo-gravador").addEventListener("click", () => {
  document.getElementById("gravador-nome").value = "";
  document.getElementById("gravador-ip").value = "";
  document.getElementById("gravador-porta").value = 80;
  document.getElementById("gravador-usuario").value = "";
  document.getElementById("gravador-senha").value = "";
  document.getElementById("gravador-snmp-ativo").checked = false;
  document.getElementById("gravador-snmp-porta").value = 161;
  document.getElementById("gravador-snmp-community").value = "public";
  document.getElementById("gravador-status-msg").textContent = "";
  document.getElementById("modal-gravador").classList.remove("hidden");
});

document.getElementById("btn-cancelar-gravador").addEventListener("click", () => {
  document.getElementById("modal-gravador").classList.add("hidden");
});

document.getElementById("btn-descobrir-canais").addEventListener("click", async () => {
  const nome = document.getElementById("gravador-nome").value.trim();
  const ip = document.getElementById("gravador-ip").value.trim();
  const portaOnvif = Number(document.getElementById("gravador-porta").value) || 80;
  const usuario = document.getElementById("gravador-usuario").value.trim();
  const senha = document.getElementById("gravador-senha").value;
  const msg = document.getElementById("gravador-status-msg");
  const botao = document.getElementById("btn-descobrir-canais");

  if (!nome || !ip || !usuario) {
    msg.textContent = "Preencha ao menos nome, IP e usuário.";
    return;
  }

  botao.disabled = true;
  botao.textContent = "Conectando...";
  msg.textContent = "Testando porta → ONVIF → login → listagem de canais (pode levar até ~1 min)...";

  try {
    const resultado = await window.cftvApi.gravadores.adicionarEDescobrirCanais({
      nome,
      ip,
      portaOnvif,
      usuario,
      senha,
      ativo: true,
      snmp: {
        ativo: document.getElementById("gravador-snmp-ativo").checked,
        porta: Number(document.getElementById("gravador-snmp-porta").value) || 161,
        community: document.getElementById("gravador-snmp-community").value.trim() || "public",
      },
    });
    msg.textContent = `✔ ${resultado.canais.length} canal(is) descoberto(s) e adicionado(s) com sucesso.`;
    setTimeout(() => {
      document.getElementById("modal-gravador").classList.add("hidden");
      carregarGravadores();
    }, 1200);
  } catch (e) {
    msg.textContent = "Falha ao conectar — " + limparErroIpc(e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = "Conectar e descobrir canais";
  }
});

// ---------------------------------------------------------------------
// Heartbeat (conectividade automática, a cada 15s)
// ---------------------------------------------------------------------
async function atualizarCardsConectividadeCompleto() {
  const cameras = await window.cftvApi.cameras.listar();
  const online = cameras.filter((c) => c.statusConectividade === "online").length;
  const offline = cameras.filter((c) => c.statusConectividade === "offline").length;
  const desconhecido = cameras.filter((c) => !c.statusConectividade || c.statusConectividade === "desconhecido").length;
  document.getElementById("conect-online").textContent = online;
  document.getElementById("conect-offline").textContent = offline;
  document.getElementById("conect-desconhecido").textContent = desconhecido;
}

function atualizarLinhasConectividadeNaTabela(resultados) {
  resultados.forEach((r) => {
    const linha = document.querySelector(`#tabela-cameras tr[data-camera-id="${r.cameraId}"]`);
    if (linha) {
      const celula = linha.querySelector(".celula-conectividade");
      if (celula) celula.innerHTML = pillConectividade(r.statusNovo, r.origemChecagem);
    }
  });
}

async function carregarEventosConectividade() {
  const eventos = await window.cftvApi.heartbeat.listarEventos(20);
  const tbody = document.querySelector("#tabela-eventos-conectividade tbody");
  if (eventos.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="hint">Nenhuma mudança de estado registrada ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = eventos
    .map(
      (e) => `
      <tr>
        <td>${new Date(e.dataHora).toLocaleString("pt-BR")}</td>
        <td>${e.nome}</td>
        <td>${pillConectividade(e.novoStatus)}</td>
      </tr>`
    )
    .join("");
}

window.cftvApi.heartbeat.aoAtualizar((resultados) => {
  atualizarCardsConectividadeCompleto();
  atualizarLinhasConectividadeNaTabela(resultados);
  if (resultados.some((r) => r.mudou)) {
    carregarEventosConectividade();
  }
});

function abrirModalCamera(camera) {
  document.getElementById("modal-titulo").textContent = camera ? "Editar câmera" : "Nova câmera";
  document.getElementById("camera-id").value = camera?.id || "";
  document.getElementById("camera-nome").value = camera?.nome || "";
  document.getElementById("camera-ip").value = camera?.ip || "";
  document.getElementById("camera-porta").value = camera?.portaOnvif ?? 80;
  document.getElementById("camera-marca").value = camera?.marca || "";
  document.getElementById("camera-usuario").value = camera?.usuario || "";
  document.getElementById("camera-senha").value = camera?.senha || "";
  document.getElementById("camera-ativa").checked = camera ? camera.ativo : true;
  document.getElementById("modal-camera").classList.remove("hidden");
}

function fecharModalCamera() {
  document.getElementById("modal-camera").classList.add("hidden");
}

document.getElementById("btn-nova-camera").addEventListener("click", () => abrirModalCamera(null));
document.getElementById("btn-cancelar-camera").addEventListener("click", fecharModalCamera);

document.getElementById("btn-salvar-camera").addEventListener("click", async () => {
  const id = document.getElementById("camera-id").value || undefined;
  const nome = document.getElementById("camera-nome").value.trim();
  const ip = document.getElementById("camera-ip").value.trim();
  const portaOnvif = Number(document.getElementById("camera-porta").value) || 80;
  const marca = document.getElementById("camera-marca").value.trim();
  const usuario = document.getElementById("camera-usuario").value.trim();
  const senha = document.getElementById("camera-senha").value;
  const ativo = document.getElementById("camera-ativa").checked;

  if (!nome || !ip || !usuario) {
    alert("Preencha ao menos nome, IP e usuário.");
    return;
  }

  await window.cftvApi.cameras.salvar({ id, nome, ip, portaOnvif, marca, usuario, senha, ativo });
  fecharModalCamera();
  carregarCameras();
});

// ---------------------------------------------------------------------
// Configuracoes
// ---------------------------------------------------------------------
async function carregarConfiguracoes() {
  const cfg = await window.cftvApi.config.obter();
  document.getElementById("cfg-ntp").value = cfg.ntpServer;
  document.getElementById("cfg-desvio").value = cfg.limites.desvioHorarioSegundos;
  document.getElementById("cfg-nitidez").value = cfg.limites.nitidezLaplaciano;
  document.getElementById("cfg-brilho-min").value = cfg.limites.brilhoMinimo;
  document.getElementById("cfg-brilho-max").value = cfg.limites.brilhoMaximo;
  document.getElementById("cfg-agendamento-ativo").checked = cfg.agendamentoAtivo;
  document.getElementById("cfg-agendamento-cron").value = cfg.agendamentoCron;
  document.getElementById("cfg-heartbeat-rapido").value = cfg.heartbeat.intervaloRapidoMs;
  document.getElementById("cfg-heartbeat-lento").value = cfg.heartbeat.intervaloLentoMs;
  document.getElementById("cfg-filtro-horario").checked = cfg.filtrosAuditoria.verificarHorario;
  document.getElementById("cfg-filtro-imagem").checked = cfg.filtrosAuditoria.verificarImagem;
  document.getElementById("cfg-telegram-ativo").checked = cfg.telegram.ativo;
  document.getElementById("cfg-telegram-token").value = cfg.telegram.botToken;
  document.getElementById("cfg-telegram-chatid").value = cfg.telegram.chatId;
  document.getElementById("cfg-central-ativo").checked = cfg.servidorCentral.ativo;
  document.getElementById("cfg-central-url").value = cfg.servidorCentral.url;
  document.getElementById("cfg-central-apikey").value = cfg.servidorCentral.apiKey;
  document.getElementById("cfg-central-intervalo").value = cfg.servidorCentral.intervaloEnvioMs;
}

function lerConfigDaTela() {
  return {
    ntpServer: document.getElementById("cfg-ntp").value.trim(),
    limites: {
      desvioHorarioSegundos: Number(document.getElementById("cfg-desvio").value),
      nitidezLaplaciano: Number(document.getElementById("cfg-nitidez").value),
      brilhoMinimo: Number(document.getElementById("cfg-brilho-min").value),
      brilhoMaximo: Number(document.getElementById("cfg-brilho-max").value),
    },
    agendamentoAtivo: document.getElementById("cfg-agendamento-ativo").checked,
    agendamentoCron: document.getElementById("cfg-agendamento-cron").value.trim(),
    heartbeat: {
      intervaloRapidoMs: Number(document.getElementById("cfg-heartbeat-rapido").value) || 15000,
      intervaloLentoMs: Number(document.getElementById("cfg-heartbeat-lento").value) || 30000,
    },
    filtrosAuditoria: {
      verificarHorario: document.getElementById("cfg-filtro-horario").checked,
      verificarImagem: document.getElementById("cfg-filtro-imagem").checked,
    },
    telegram: {
      ativo: document.getElementById("cfg-telegram-ativo").checked,
      botToken: document.getElementById("cfg-telegram-token").value.trim(),
      chatId: document.getElementById("cfg-telegram-chatid").value.trim(),
    },
    servidorCentral: {
      ativo: document.getElementById("cfg-central-ativo").checked,
      url: document.getElementById("cfg-central-url").value.trim(),
      apiKey: document.getElementById("cfg-central-apikey").value.trim(),
      intervaloEnvioMs: Number(document.getElementById("cfg-central-intervalo").value) || 120000,
    },
  };
}

async function salvarConfiguracoesAtual() {
  await window.cftvApi.config.salvar(lerConfigDaTela());
}

document.getElementById("btn-salvar-config").addEventListener("click", async () => {
  await salvarConfiguracoesAtual();
  const msg = document.getElementById("config-salvo-msg");
  msg.classList.remove("hidden");
  setTimeout(() => msg.classList.add("hidden"), 2500);
});

document.getElementById("btn-testar-telegram").addEventListener("click", async () => {
  const botao = document.getElementById("btn-testar-telegram");
  botao.disabled = true;
  botao.textContent = "Enviando...";
  try {
    // Salva antes de testar, para garantir que o teste usa os valores atuais da tela
    await salvarConfiguracoesAtual();
    await window.cftvApi.config.testarTelegram();
    alert("Mensagem de teste enviada com sucesso!");
  } catch (e) {
    alert("Falha ao enviar: " + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = "Enviar mensagem de teste";
  }
});

document.getElementById("btn-testar-central").addEventListener("click", async () => {
  const botao = document.getElementById("btn-testar-central");
  botao.disabled = true;
  botao.textContent = "Enviando...";
  try {
    await salvarConfiguracoesAtual();
    await window.cftvApi.config.testarServidorCentral();
    alert("Relatório de teste enviado com sucesso ao servidor central!");
  } catch (e) {
    alert("Falha ao enviar: " + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = "Enviar teste agora";
  }
});

// ---------------------------------------------------------------------
// Historico
// ---------------------------------------------------------------------
async function carregarHistorico() {
  const historico = await window.cftvApi.historico.listar(50);
  const tbody = document.querySelector("#tabela-historico tbody");
  tbody.innerHTML = historico
    .map(
      (h) => `
      <tr>
        <td>${new Date(h.dataHoraInicio).toLocaleString("pt-BR")}</td>
        <td>${h.totalCameras}</td>
        <td>${h.ok}</td>
        <td>${h.atencao}</td>
        <td>${h.offline}</td>
        <td>${h.manual}</td>
      </tr>`
    )
    .join("");
}

// ---------------------------------------------------------------------
// Correcao de horario em lote
// ---------------------------------------------------------------------
async function executarCorrecaoHorario(filtro, botao) {
  const textoOriginal = botao.textContent;
  const resultadoDiv = document.getElementById("resultado-correcao-horario");
  botao.disabled = true;
  botao.textContent = "Corrigindo...";
  resultadoDiv.innerHTML = "";

  try {
    const resultados = await window.cftvApi.horario.corrigirEmLote(filtro);

    if (resultados.length === 0) {
      resultadoDiv.innerHTML =
        filtro === "comDesvio"
          ? '<p class="hint">Nenhuma câmera com desvio de horário na última auditoria — nada a corrigir.</p>'
          : '<p class="hint">Nenhuma câmera ativa encontrada.</p>';
      return;
    }

    const sucesso = resultados.filter((r) => r.sucesso).length;
    const falhas = resultados.filter((r) => !r.sucesso);

    let html = `<p class="hint"><b>${sucesso}/${resultados.length}</b> câmera(s) corrigida(s) com sucesso.</p>`;
    if (falhas.length > 0) {
      html += '<div class="lista-correcao">';
      html += falhas
        .map((f) => `<div class="conect-offline">✗ ${f.nome}: ${f.erro || "falha desconhecida"}</div>`)
        .join("");
      html += "</div>";
    }
    resultadoDiv.innerHTML = html;

    if (!document.getElementById("tab-cameras").classList.contains("hidden")) {
      carregarCameras();
    }
  } catch (e) {
    resultadoDiv.innerHTML = `<p class="hint conect-offline">Falha: ${e.message}</p>`;
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

document.getElementById("btn-corrigir-horario-desvio").addEventListener("click", (e) => {
  executarCorrecaoHorario("comDesvio", e.target);
});

document.getElementById("btn-corrigir-horario-todas").addEventListener("click", (e) => {
  if (confirm("Isso vai enviar o horário correto (via NTP) para TODAS as câmeras ativas agora. Continuar?")) {
    executarCorrecaoHorario("todas", e.target);
  }
});

// ---------------------------------------------------------------------
// Inicializacao
// ---------------------------------------------------------------------
carregarUltimaExecucao();
carregarEventosConectividade();
atualizarCardsConectividadeCompleto();
