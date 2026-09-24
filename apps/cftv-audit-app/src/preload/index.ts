import { contextBridge, ipcRenderer } from "electron";

const api = {
  cameras: {
    listar: () => ipcRenderer.invoke("cameras:listar"),
    salvar: (camera: any) => ipcRenderer.invoke("cameras:salvar", camera),
    remover: (id: string) => ipcRenderer.invoke("cameras:remover", id),
  },
  gravadores: {
    listar: () => ipcRenderer.invoke("gravadores:listar"),
    adicionarEDescobrirCanais: (dados: any) =>
      ipcRenderer.invoke("gravadores:adicionarEDescobrirCanais", dados),
    remover: (id: string) => ipcRenderer.invoke("gravadores:remover", id),
    testarSaude: (id: string) => ipcRenderer.invoke("gravadores:testarSaude", id),
  },
  heartbeat: {
    listarEventos: (limite?: number) => ipcRenderer.invoke("heartbeat:eventos", limite),
    aoAtualizar: (callback: (resultados: any[]) => void) => {
      const listener = (_evt: any, resultados: any[]) => callback(resultados);
      ipcRenderer.on("heartbeat:atualizado", listener);
      return () => ipcRenderer.removeListener("heartbeat:atualizado", listener);
    },
    aoNivelGravadorAtualizar: (callback: (info: { gravadorId: string; nivel: string }) => void) => {
      const listener = (_evt: any, info: any) => callback(info);
      ipcRenderer.on("heartbeat:nivelGravadorAtualizado", listener);
      return () => ipcRenderer.removeListener("heartbeat:nivelGravadorAtualizado", listener);
    },
    aoPausar: (callback: (pausado: boolean) => void) => {
      const listener = (_evt: any, pausado: boolean) => callback(pausado);
      ipcRenderer.on("heartbeat:pausado", listener);
      return () => ipcRenderer.removeListener("heartbeat:pausado", listener);
    },
  },
  horario: {
    corrigirEmLote: (filtro: "todas" | "comDesvio") => ipcRenderer.invoke("horario:corrigirEmLote", filtro),
  },
  config: {
    obter: () => ipcRenderer.invoke("config:obter"),
    salvar: (config: any) => ipcRenderer.invoke("config:salvar", config),
    testarTelegram: () => ipcRenderer.invoke("config:testarTelegram"),
    testarServidorCentral: () => ipcRenderer.invoke("config:testarServidorCentral"),
  },
  auditoria: {
    executarAgora: () => ipcRenderer.invoke("auditoria:executarAgora"),
    aoProgresso: (callback: (resultado: any) => void) => {
      const listener = (_evt: any, resultado: any) => callback(resultado);
      ipcRenderer.on("auditoria:progresso", listener);
      return () => ipcRenderer.removeListener("auditoria:progresso", listener);
    },
    aoConcluirAgendada: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("execucao-agendada-concluida", listener);
      return () => ipcRenderer.removeListener("execucao-agendada-concluida", listener);
    },
  },
  historico: {
    listar: (limite?: number) => ipcRenderer.invoke("historico:listar", limite),
  },
};

contextBridge.exposeInMainWorld("cftvApi", api);

export type CftvApi = typeof api;
