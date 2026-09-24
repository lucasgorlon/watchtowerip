# App Local — "Auditoria CFTV" (projeto `cftv-audit-app`)

Aplicativo desktop Windows (Electron + TypeScript), instalado em cada site
do cliente, responsável por todo o monitoramento local de câmeras e
gravadores CFTV.

## Estrutura de módulos (processo principal)

```
src/main/
  index.ts               janela + todos os handlers de IPC
  store.ts                 banco local (JSON via lowdb)
  onvifClient.ts            conexão ONVIF: descoberta de canais, horário, snapshot, ajuste de horário
  imageAnalysis.ts          nitidez (variância do Laplaciano) e brilho da imagem
  ntp.ts                    horário de referência via NTP
  auditRunner.ts            orquestra a auditoria completa manual
  heartbeatRunner.ts        orquestra a checagem de conectividade automática
  isapiStatus.ts             status de canal via ISAPI (lote e por canal)
  protocoloGravador.ts       detecção de fabricante (ISAPI vs Dahua CGI) + coletor de disco Dahua
  saudeGravador.ts           orquestra a coleta de saúde do gravador (disco/CPU-memória/rede)
  timeSyncRunner.ts          correção de horário em lote via ONVIF
  relatorioCentral.ts        monta e envia o resumo periódico ao servidor central
  estadoAuditoria.ts         flag compartilhada para pausar o heartbeat durante auditoria/correção manual
  scheduler.ts               agendamento cron da auditoria completa
  notifiers/                 Telegram (funcional) + WhatsApp/E-mail (placeholders prontos para implementar)
src/preload/index.ts       ponte segura entre main e renderer (contextBridge)
src/renderer/               interface (HTML/CSS/JS puro, sem framework)
```

## Por que sem módulos nativos

`better-sqlite3`, `sharp` etc. exigem compilação nativa (Python +
compilador C++) na máquina onde rodam, o que complica gerar o instalador
Windows a partir de outro sistema operacional e pode falhar em máquinas
Windows sem ferramentas de desenvolvimento instaladas (ver documento 05).
Por isso o app usa só bibliotecas 100% JavaScript: `lowdb` (armazenamento),
`jimp` (processamento de imagem), `onvif` (protocolo ONVIF), `node-cron`
(agendamento), `ntp-time` (consulta NTP), `net-snmp` (SNMP), `digest-fetch`
(autenticação HTTP Digest para ISAPI/CGI).

## Duas formas de cadastrar equipamento

- **Aba Gravadores**: cadastra o NVR inteiro (IP + porta ONVIF +
  usuário/senha) e o app descobre automaticamente todos os canais via
  ONVIF `GetProfiles`, criando uma "câmera" por canal. Remover o gravador
  remove em cascata todos os canais associados.
  - **Detalhe técnico importante**: `GetProfiles` costuma retornar DOIS
    perfis por canal físico (stream principal + substream). A descoberta
    agrupa os perfis pelo `sourceToken` da `VideoSourceConfiguration`
    (identifica o canal físico de verdade) e mantém só o de maior
    resolução — isso corrigiu um bug real onde um gravador de 32 canais
    (31 online) aparecia com 62 canais descobertos.
- **Aba Câmeras**: cadastro individual, direto por IP — usado quando não
  há gravador, ou misturado com canais vindos de gravador na mesma
  auditoria.

## Heartbeat de conectividade (automático)

Roda continuamente, com **paralelização entre gravadores** (cada gravador
tem seu próprio temporizador independente, não serializado) e **intervalo
adaptativo**:

- Câmeras individuais: TCP puro direto na câmera, sempre no intervalo
  rápido (padrão 15s) — barato mesmo em centenas de endpoints.
- Canais de gravador: tenta em 4 camadas, da mais leve para a mais
  pesada, caindo para a próxima só se a anterior não for suportada:
  1. **ISAPI em lote** (`/ISAPI/ContentMgmt/InputProxy/channels/status`) —
     uma chamada cobre todos os canais do gravador.
  2. **ISAPI por canal** (`/ISAPI/ContentMgmt/InputProxy/channels/{id}/status`)
     — formato oficialmente documentado pela Hikvision.
  3. **ONVIF por canal** (checa disponibilidade do snapshot via
     `GetSnapshotUri` + HEAD/GET sem baixar a imagem inteira) — usado
     quando o gravador não implementa nenhuma rota ISAPI.
  4. **TCP no gravador como um todo** — último recurso; não distingue
     canal por canal, só diz se o NVR está de pé.
- O intervalo de cada gravador se ajusta sozinho: camada ISAPI usa o
  intervalo rápido (padrão 15s); camadas ONVIF-por-canal ou TCP-gravador
  usam o intervalo lento (padrão 30s, configurável). Um gravador que
  melhora de camada (ex: após update de firmware) volta sozinho pro
  intervalo rápido.
- Só grava evento e só notifica Telegram **quando o estado muda**
  (online→offline ou vice-versa) — nunca a cada ciclo.

### Fórmula para avaliar se um intervalo é seguro

```
tempo_do_ciclo = ceil(canais_do_gravador / concorrência) × tempo_médio_por_requisição
```

Regra prática: manter `tempo_do_ciclo` abaixo de 60-70% do intervalo
escolhido. Concorrência/tempo aproximado por camada: ISAPI ~8 de
concorrência e ~200ms/requisição (sobra folga até milhares de canais);
ONVIF por canal ~6 de concorrência e ~500ms/requisição (mais sensível —
por isso o intervalo lento).

## Auditoria completa (manual)

Disparada pelo botão "Executar auditoria agora" ou por agendamento cron
configurável. Verifica, por câmera/canal:

- **Horário**: via ONVIF (`GetSystemDateAndTime`), comparado com um
  horário de referência obtido via NTP.
- **Qualidade de imagem**: baixa o snapshot e calcula nitidez (variância
  do filtro Laplaciano — valores baixos indicam desfoque/lente suja) e
  brilho médio.

**Filtros configuráveis**: em Configurações, dá para desligar a
verificação de horário ou de imagem independentemente. Desligar "qualidade
de imagem" acelera bastante a auditoria (pula download e processamento de
snapshot). Se as duas estiverem desligadas, a câmera nem é conectada via
ONVIF.

**Pausa automática do heartbeat**: enquanto a auditoria completa (ou a
correção de horário em lote) está rodando, os dois loops de heartbeat
pulam seus ciclos automaticamente e retomam sozinhos ao final — evita que
processos pesados e leves disputem rede/gravador ao mesmo tempo.

## Correção de horário em lote

Dois botões no Dashboard enviam o horário correto (obtido via NTP pelo
próprio app) diretamente para os dispositivos via ONVIF
(`SetSystemDateAndTime`, modo Manual) — mais confiável que apontar a
câmera para um NTP externo, pois não depende dela alcançar esse servidor
sozinha:

- Corrigir só as câmeras com desvio detectado na última auditoria.
- Corrigir todas as câmeras ativas, sem depender de auditoria prévia.

**Deduplicação por gravador**: canais do mesmo gravador compartilham o
relógio físico do NVR — o sistema agrupa por gravador e manda um único
comando por dispositivo físico, em vez de repetir por canal.

## Saúde do gravador (disco, CPU/memória, rede)

Coletada a cada envio ao servidor central (não a cada heartbeat). Três
fontes independentes, cada uma podendo falhar sem derrubar as outras:

- **Disco**: tenta em cascata — ISAPI (`/ISAPI/ContentMgmt/Storage`,
  família Hikvision) → CGI Dahua (`/cgi-bin/magicBox.cgi?action=getDeviceAllInfo`,
  família Dahua/Intelbras) → SNMP genérico (`HOST-RESOURCES-MIB::hrStorageTable`,
  último recurso, independe de fabricante mas depende do agente SNMP
  implementar essa MIB).
- **CPU/memória**: via ISAPI (`/ISAPI/System/status`) — só implementado
  para a família ISAPI até o momento; não há endpoint Dahua CGI
  documentado com confiabilidade equivalente ainda.
- **Rede (Mbps)**: via SNMP (contadores IF-MIB, `ifHCInOctets`/`ifHCOutOctets`
  de 64 bits com fallback para os de 32 bits) — não existe endpoint ISAPI
  padronizado para tráfego real (só velocidade nominal do link).

**Detecção automática de fabricante/protocolo**: o app tenta identificar
se o gravador fala ISAPI ou CGI Dahua (`/ISAPI/System/deviceInfo` vs
`/cgi-bin/magicBox.cgi?action=getVendor`), guarda o resultado em cache no
cadastro do gravador, e tenta de novo automaticamente se ficar marcado
como "nenhum" (útil após updates de firmware).

Botão "Testar saúde agora" na aba Gravadores roda a coleta na hora, sem
esperar o próximo ciclo — útil para validar ISAPI/SNMP/CGI antes de deixar
rodando automático.

## Notificações (Telegram)

Arquitetura plugável: interface `Notifier` comum, com `TelegramNotifier`
implementado e funcional, e `WhatsAppNotifier`/`EmailNotifier` como
placeholders documentados (prontos para receber implementação futura sem
mudar o restante do sistema). Notifica em duas situações: mudança de
estado de conectividade (heartbeat) e resultado de auditoria completa
(só quando há algo fora do status OK).

## Integração com o servidor central

Em Configurações → "Servidor central": ativa o envio, define a URL (IP da
VPN do servidor central) e a API key (gerada no servidor central com
`npm run criar-cliente`). A cada ciclo (padrão 2 minutos), envia um resumo
leve: contagem de câmeras online/offline, resultado da última auditoria
completa, e saúde de cada gravador ativo. Roda em paralelo a tudo mais,
sem interferir no heartbeat ou na auditoria.

## Armazenamento local

JSON via `lowdb`, em `%APPDATA%\auditoria-cftv\dados.json` no Windows.
Inclui câmeras, gravadores, configurações e histórico (últimas 200
execuções de auditoria, últimos 2000 eventos de conectividade).

## Segurança — pendências conhecidas

Senhas de câmeras/gravadores e o token do Telegram ficam salvos em texto
puro no arquivo local. Para produção (especialmente se o app rodar numa
estação de trabalho compartilhada), recomenda-se cifrar com `safeStorage`
do próprio Electron antes de gravar no JSON — mudança pequena, localizada
em `store.ts`, ainda não implementada.

## Identidade visual

Ícone do app (janela, taskbar, instalador `.ico`) e logo da barra lateral
usam a marca "tu Soluções Inteligentes". A imagem original tinha uma área
branca opaca escondida atrás do símbolo (invisível em fundo branco, mas
apareceria como mancha no fundo escuro do app) — foi limpa antes de gerar
os ícones finais.
