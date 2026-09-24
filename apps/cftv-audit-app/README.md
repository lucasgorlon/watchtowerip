# Auditoria CFTV — Aplicativo Desktop (Electron + TypeScript)

Aplicativo Windows com interface gráfica para auditoria automática de câmeras
CFTV multi-marca via ONVIF: verificação de horário, nitidez de imagem (lente
suja/desfocada) e brilho, com agendamento embutido e notificações por
Telegram.

Reescrita 100% em Node.js/TypeScript (sem dependência de runtime Python), com
apenas bibliotecas puramente JS — não há módulos nativos, o que simplifica
bastante gerar o instalador para Windows a partir de qualquer sistema.

## Arquitetura

```
src/
  main/                    processo principal do Electron (backend)
    index.ts               janela + handlers de IPC
    store.ts                banco local (JSON via lowdb, sem módulo nativo)
    onvifClient.ts          conexão ONVIF: horário + snapshot
    imageAnalysis.ts        nitidez (Laplaciano) e brilho da imagem
    ntp.ts                  horário de referência (NTP)
    auditRunner.ts          orquestra a auditoria de todas as câmeras
    scheduler.ts            agendamento (node-cron)
    notifiers/
      Notifier.ts            interface comum a todos os canais
      TelegramNotifier.ts     implementado e funcional
      WhatsAppNotifier.ts     placeholder — pronto para implementar depois
      EmailNotifier.ts        placeholder — pronto para implementar depois
      index.ts                fábrica que ativa os canais configurados
  preload/index.ts          ponte segura entre main e renderer (contextBridge)
  renderer/                 interface (HTML/CSS/JS puro, sem framework)
```

### Por que sem módulos nativos?

`better-sqlite3`, `sharp`, etc. exigem binários pré-compilados por
plataforma/arquitetura, o que complica gerar o instalador Windows a partir de
outro sistema operacional. Por isso o projeto usa:

- **lowdb** (JSON puro) em vez de SQLite nativo
- **jimp** (decodificação e processamento de imagem 100% em JS) em vez de `sharp`
- **onvif** (biblioteca pura JS) para o protocolo ONVIF
- **node-cron** para agendamento
- **ntp-time** para consulta NTP

Isso resulta em um instalador mais simples de gerar e mais portátil, ao custo
de ser um pouco mais lento em datasets muito grandes — irrelevante para o
volume de ~150 câmeras.

## Paralelização entre gravadores + intervalo adaptativo

**Importante para quem vai escalar além de um gravador de bancada:** o heartbeat
não roda mais como um único ciclo global que soma o tempo de todos os
gravadores. Agora:

- **Câmeras individuais** têm seu próprio loop (`setInterval`), sempre no
  intervalo rápido (padrão 15s) — TCP puro é barato mesmo em centenas de
  endpoints, então não precisa de ajuste.
- **Cada gravador tem seu próprio temporizador independente**, que roda em
  paralelo com os demais gravadores (não serializado). Isso evita que o
  tempo de 2, 5 ou 10 gravadores se some — cada um processa seus canais no
  seu próprio ritmo, ao mesmo tempo que os outros.
- **O intervalo de cada gravador se ajusta sozinho** conforme a camada de
  checagem que está funcionando nele:
  - ISAPI (leve) → intervalo **rápido** (padrão 15s)
  - ONVIF-por-canal ou TCP-gravador (mais pesado) → intervalo **lento**
    (padrão 30s)
  - Isso é decidido automaticamente a cada ciclo — se um gravador que
    estava no fallback passar a responder ISAPI (ex: depois de um upgrade
    de firmware), ele volta sozinho para o intervalo rápido no próximo
    ciclo.
- Ambos os intervalos (rápido/lento) são configuráveis na aba
  Configurações → painel "Heartbeat".
- A aba Gravadores mostra, por gravador, qual camada está em uso e qual
  intervalo está sendo aplicado no momento — útil para confirmar que a
  paralelização e o ajuste automático estão se comportando como esperado
  antes de escalar para produção.

### Como calcular se um intervalo é seguro para o seu cenário

```
tempo_do_ciclo = ceil(canais_do_gravador / concorrência) × tempo_médio_por_requisição
```

Concorrência e tempo médio aproximado por camada:

| Camada | Concorrência | Tempo médio/req | Uso recomendado |
|---|---|---|---|
| ISAPI (lote ou por canal) | 8 | ~200ms | Intervalo rápido (15s) sobra folga até milhares de canais |
| ONVIF por canal | 6 | ~500ms | Regra prática: manter `tempo_do_ciclo` abaixo de 60-70% do intervalo escolhido |

Como cada gravador agora roda em paralelo com os demais, o que importa é o
**pior caso entre os gravadores individualmente**, não a soma de todos —
diferente do comportamento anterior (sequencial), que somava.

## Logo e identidade visual

O ícone do app (janela, taskbar, instalador) e o logo na barra lateral usam a
marca fornecida ("tu Soluções Inteligentes"). O arquivo original tinha uma
área branca opaca escondida atrás do símbolo (invisível em fundo branco, mas
que apareceria como uma mancha no fundo escuro do app) — ela foi limpa antes
de gerar os ícones. Os arquivos finais estão em `assets/icon.png`,
`assets/icon.ico` (instalador Windows) e `src/renderer/assets/logo.png`
(barra lateral). Para trocar a marca no futuro, repita esse processo com o
novo arquivo de origem.

## Pausa automática do heartbeat durante auditoria/correção manual

Enquanto a auditoria completa (botão "Executar auditoria agora") ou a
correção de horário em lote estiverem rodando, os dois loops de heartbeat
(câmeras individuais e cada gravador) **pulam seus ciclos automaticamente**
— sem parar de vez, só ficam em espera e retomam sozinhos assim que o
processo manual termina. Isso evita que auditoria pesada (download de
snapshot + processamento) e heartbeat leve disputem rede/gravador ao mesmo
tempo. Um aviso amarelo aparece no topo do Dashboard enquanto isso acontece.

## Filtros configuráveis na auditoria completa

Em Configurações → "Filtros da auditoria completa", dá pra desligar
"Verificar qualidade de imagem" e deixar a auditoria manual checar só
horário (ou vice-versa). Quando qualidade de imagem está desligada, a
auditoria pula completamente o download e processamento de snapshot — fica
bem mais rápida. Se as duas estiverem desligadas, a câmera nem chega a ser
conectada via ONVIF.

## Ajuste de horário em lote via NTP

No Dashboard, dois botões enviam o horário correto (já obtido pelo próprio
app via NTP) direto para os dispositivos via ONVIF (`SetSystemDateAndTime`,
modo Manual) — mais confiável que só apontar a câmera para um NTP externo,
porque não depende dela conseguir alcançar esse servidor sozinha:

- **Corrigir horário das câmeras com desvio**: usa o resultado da última
  auditoria completa para saber quais câmeras estão com `DESVIO_DE_HORARIO`
  e corrige só essas.
- **Corrigir horário de todas as câmeras ativas**: corrige todo mundo, sem
  depender de auditoria prévia.

**Deduplicação por gravador:** canais do mesmo gravador compartilham o
relógio físico do NVR, então em vez de repetir o comando uma vez por canal
(o que seria redundante e mais lento), o sistema agrupa por gravador e manda
**um único comando** por dispositivo físico, aplicando o resultado a todos
os canais daquele grupo no relatório.

## Duas formas de monitorar: gravador inteiro ou câmeras individuais

**Aba Gravadores** — cadastre o NVR inteiro (IP + porta ONVIF + usuário/senha) e o
app conecta via ONVIF, descobre automaticamente todos os canais (`GetProfiles`)
e cria uma "câmera" para cada canal encontrado — sem digitar IP de câmera
nenhuma. Validado nas especificações do Intelbras iNVD 3032 (ONVIF Perfil S/T/G).
Remover o gravador remove em cascata todos os canais associados a ele.

**Aba Câmeras** — continua existindo para cadastro individual, direto por IP.
Use este caminho quando não há gravador (câmeras standalone) ou para misturar
com canais vindos de um gravador na mesma auditoria.

## Conectividade automática (heartbeat) vs. auditoria completa (manual)

O app roda **dois processos com velocidades diferentes**, de propósito:

- **Heartbeat de conectividade — automático, a cada 15 segundos, sempre ativo.**
  Só verifica se a câmera/canal está online ou offline:
  - Câmeras individuais: teste de conexão TCP direto na câmera.
  - Canais de gravador: tenta em **3 camadas**, da mais leve para a mais pesada,
    caindo para a próxima só se a anterior não for suportada pelo gravador:
    1. **ISAPI em lote** (`/ISAPI/ContentMgmt/InputProxy/channels/status`) — uma
       única chamada cobre todos os canais. Mais eficiente quando suportado.
    2. **ISAPI por canal** (`/ISAPI/ContentMgmt/InputProxy/channels/{id}/status`)
       — é o formato oficialmente documentado pela Hikvision; ainda leve
       (XML pequeno, sem imagem), só que uma chamada por canal em vez de uma
       para todos.
    3. **ONVIF por canal** (checagem de disponibilidade do snapshot, sem
       baixar/processar a imagem inteira) — usada quando o gravador não
       implementa nenhuma das rotas ISAPI acima (caso comum em NVRs
       multi-marca). Mais pesada que ISAPI, mas ainda automática e com
       granularidade por canal — é o mesmo mecanismo que a auditoria manual
       já usa com sucesso para detectar canais com problema.
    4. **TCP no gravador como um todo** — último recurso, só usado se nem
       ONVIF por canal funcionar. Nesse caso a granularidade cai para "o
       gravador está de pé", sem distinguir canal por canal.

    Passe o mouse sobre o status de conectividade de qualquer câmera na aba
    Câmeras para ver qual dessas 4 camadas foi usada na última checagem.
  - Só grava evento e só notifica no Telegram **quando o estado muda**
    (online→offline ou offline→online) — nunca a cada ciclo, para não gerar
    spam nem inchar o histórico.
- **Auditoria completa — manual, via botão "Executar auditoria agora".**
  Continua fazendo o que fazia antes: verificação de horário (ONVIF +
  NTP) e qualidade de imagem (nitidez/brilho) de cada câmera/canal. Como
  envolve baixar snapshot e processar imagem, deliberadamente **não** roda
  sozinha em background — fica sob controle do operador.

Essa separação existe porque as duas coisas têm urgências e custos bem
diferentes: perceber que uma câmera caiu deve ser quase instantâneo e muito
leve; verificar se a lente está suja pode esperar um clique, já que isso não
muda em segundos.

## Como adicionar câmeras / configurar

Diferente do script Python de bancada (que usa `config.json`), aqui tudo é
feito pela interface gráfica:

1. Aba **Câmeras** → "+ Adicionar câmera" → preencha nome, IP, porta ONVIF,
   marca, usuário e senha.
2. Aba **Configurações** → ajuste limites de nitidez/brilho/horário,
   agendamento (expressão cron) e credenciais do Telegram.
3. Aba **Dashboard** → botão "Executar auditoria agora" para rodar uma
   verificação manual a qualquer momento.
4. Aba **Histórico** → todas as execuções anteriores (mantém as últimas 200).

Os dados ficam salvos localmente em:
`%APPDATA%\auditoria-cftv\dados.json` (Windows) — inclui câmeras, senhas
(em texto puro no momento — veja "Segurança" abaixo), configurações e
histórico.

## Configurando o Telegram

1. No Telegram, converse com **@BotFather** → `/newbot` → siga as instruções
   → copie o **token** gerado.
2. Descubra o **Chat ID** de destino:
   - Para receber no seu chat pessoal: converse com **@userinfobot**, ele
     devolve seu ID.
   - Para receber em um grupo: adicione o bot ao grupo, envie uma mensagem
     qualquer, e acesse `https://api.telegram.org/bot<TOKEN>/getUpdates` no
     navegador para achar o `chat.id` do grupo (geralmente um número
     negativo).
3. Cole token e chat ID na aba Configurações, ative o Telegram, clique em
   "Salvar configurações" e depois em "Enviar mensagem de teste".

Por padrão, o app **só envia notificação quando há câmera fora do status OK**
(evita spam a cada execução bem-sucedida). Isso está em
`auditRunner.ts → enviarResumoNotificacao`, é fácil de ajustar se quiser
notificação de toda execução.

## Rodando em modo desenvolvimento

Requer Node.js 18+ e um ambiente com interface gráfica (Windows, macOS, ou
Linux com X11/Wayland — **não funciona em um terminal sem display**).

```bash
npm install
npm start
```

## Gerando o instalador para Windows

```bash
npm run dist:win
```

Isso gera um instalador `.exe` (NSIS) em `dist_electron/` (ou `dist/` — o
electron-builder cria uma pasta própria, não confundir com `dist/` do
TypeScript).

**Importante sobre plataforma de build:** o electron-builder consegue gerar
o instalador Windows a partir de Linux/macOS em muitos casos, mas o caminho
mais confiável é:
- Rodar `npm run dist:win` diretamente em uma máquina Windows, **ou**
- Usar um workflow de CI (GitHub Actions com `runs-on: windows-latest`) que
  roda `npm ci && npm run dist:win` automaticamente a cada release.

Recomendo a segunda opção para produção — evita depender de Wine/configuração
extra no Linux e garante um build limpo, reproduzível e assinável.

### Ícone do aplicativo

Ainda não há um ícone customizado. Para adicionar: coloque um arquivo
`assets/icon.ico` (256x256, formato ICO) e adicione de volta
`"icon": "assets/icon.ico"` em `build.win` no `package.json`.

## Adicionando WhatsApp ou E-mail no futuro

A arquitetura já foi pensada para isso. Basta:

1. Implementar `estaConfigurado()` e `enviarMensagem()` em
   `WhatsAppNotifier.ts` (ou `EmailNotifier.ts`) seguindo exatamente o mesmo
   contrato usado em `TelegramNotifier.ts`.
2. Nada mais precisa mudar — `notifiers/index.ts` já detecta automaticamente
   qualquer canal com `estaConfigurado() === true` e o `auditRunner.ts` já
   dispara mensagens por todos os canais ativos.
3. Adicionar os campos correspondentes na aba Configurações do
   `index.html`/`renderer.js` (os painéis "Em breve" já estão no lugar certo,
   só remover a classe `painel-desativado` e ligar os inputs).

Para WhatsApp especificamente, os comentários dentro de `WhatsAppNotifier.ts`
já documentam os dois caminhos recomendados (Meta Cloud API oficial vs.
Twilio) e por que evitar bibliotecas não-oficiais tipo `whatsapp-web.js` em
um produto entregue a cliente (risco de bloqueio do número).

## Segurança — pontos de atenção antes de entregar ao cliente

- **Senhas das câmeras são salvas em texto puro** no `dados.json` local.
  Para produção, vale considerar:
  - Usar `safeStorage` do próprio Electron (criptografia ligada à conta do
    Windows) para cifrar as senhas antes de gravar no JSON.
  - Restringir permissões do arquivo/pasta de dados.
- O token do Telegram também fica salvo localmente — mesmo cuidado se
  aplica.
- Posso implementar a criptografia com `safeStorage` como próximo passo, é
  uma mudança pequena e localizada em `store.ts`.

## Limitações conhecidas do modelo "canal de gravador"

- **Horário**: para canais vindos de um gravador, a auditoria completa
  consulta o relógio do **próprio gravador** via ONVIF (as credenciais
  usadas são as do NVR, não de cada câmera individualmente) — na prática
  todos os canais de um mesmo gravador reportam o mesmo horário. Isso é
  esperado: o NVR normalmente centraliza o timestamp de gravação.
- **Snapshot**: cada canal usa seu próprio `token` de perfil ONVIF
  (`canalToken`) para garantir que a imagem analisada é a do canal certo, e
  não sempre a do canal 1.
- **Status ISAPI**: o endpoint de status por canal é um padrão Hikvision,
  amplamente compatível com a linha Intelbras (iNVD é baseado nessa
  plataforma), mas não é garantido em NVRs de outras marcas. Quando não
  suportado, o app avisa na aba Gravadores e usa o fallback de TCP no
  gravador como um todo — vale conferir esse indicador após cadastrar cada
  gravador novo.

## Detecção automática de fabricante/protocolo (ISAPI vs Dahua CGI)

Nem todo gravador fala ISAPI — inclusive dentro da própria linha Intelbras,
que mistura equipamentos derivados de Hikvision (ISAPI) e de Dahua (CGI
`/cgi-bin/...`). Por isso a coleta de disco agora tenta, nessa ordem:

1. **ISAPI** (`/ISAPI/ContentMgmt/Storage`) — família Hikvision.
2. **CGI Dahua** (`/cgi-bin/magicBox.cgi?action=getDeviceAllInfo`) — família
   Dahua/Intelbras. Formato de resposta é texto simples `chave=valor`, não
   XML.
3. **SNMP genérico** (`HOST-RESOURCES-MIB::hrStorageTable`) — último
   recurso, funciona com qualquer fabricante *se* o agente SNMP do
   equipamento implementar essa MIB (nem todo firmware embarcado
   implementa — muitos só têm a IF-MIB de rede).

A detecção do protocolo (`/ISAPI/System/deviceInfo` vs
`/cgi-bin/magicBox.cgi?action=getVendor`) roda uma vez e fica em cache no
cadastro do gravador — não reprova a cada coleta. Se ficar marcado como
"nenhum" (nem ISAPI nem CGI Dahua responderam), o app tenta de novo na
próxima coleta automaticamente — útil depois de um update de firmware, sem
precisar remover e recadastrar o gravador.

Na tabela de Gravadores, o resumo de saúde mostra entre colchetes qual fonte
respondeu (`[ISAPI]`, `[CGI Dahua]` ou `[SNMP]`), e o ⓘ no erro mostra o
motivo de cada tentativa que falhou.

**Honestidade sobre o que foi validado**: o parser do CGI Dahua segue a
documentação oficial do protocolo Dahua HTTP API v2.0, mas **ainda não foi
testado contra um gravador Intelbras real** — é natural que o formato exato
varie um pouco entre modelos/firmwares, como já aconteceu com o endpoint de
status de canal do ISAPI. Ao testar na bancada, use o botão "Testar saúde
agora" e, se o disco aparecer como "indisponível", passe o mouse no ⓘ e me
manda a mensagem — a essa altura já sabemos o processo pra ajustar rápido.

**CPU/memória continuam só via ISAPI por enquanto** — não há um endpoint
Dahua CGI documentado com a mesma confiabilidade do de disco, e forçar um
palpite depois de já termos errado duas vezes esse tipo de suposição não
parecia o caminho certo. Fica como próximo passo, se fizer falta.

## Saúde do gravador (disco, CPU/memória, rede)

Coletada automaticamente **a cada envio ao servidor central** (não a cada
heartbeat — não faz sentido monitorar disco/rede a cada 15s, e isso mantém a
coleta leve). Três fontes diferentes, cada uma falhando de forma
independente sem derrubar as outras:

- **Disco (HDD)**: via ISAPI (`/ISAPI/ContentMgmt/Storage`) — mesmas
  credenciais já usadas para ONVIF. Não precisa de configuração extra.
- **CPU e memória**: via ISAPI (`/ISAPI/System/status`) — de brinde, usa o
  mesmo endpoint.
- **Consumo de rede (Mbps)**: via **SNMP** (contadores padrão IF-MIB). Não
  existe endpoint ISAPI padronizado para tráfego real (só velocidade
  nominal do link, que é outra coisa) — por isso SNMP aqui. Precisa estar
  **habilitado no gravador** (normalmente em Configuração → Rede → SNMP) e
  configurado na aba Gravadores deste app (community + porta, opcional —
  desativado por padrão).

Cada canal/câmera vinda de um gravador aponta pro mesmo `gravadorId`, então
a saúde é coletada **uma vez por gravador**, nunca por canal.

Na aba Gravadores, o botão **"Testar saúde agora"** roda a coleta na hora,
sem esperar o próximo ciclo de envio — útil para confirmar que o ISAPI/SNMP
respondem antes de deixar rodando automático.

**Limitação conhecida do cálculo de rede via SNMP**: os contadores podem ser
de 32 ou 64 bits dependendo do que o gravador suporta (o app tenta 64 bits
primeiro, com fallback automático para 32). Contadores de 32 bits podem
"zerar e recomeçar" (overflow) em poucos minutos num link gigabit sob carga
muito alta — o código já trata esse caso, mas num instante exato de
overflow o número daquela leitura específica pode sair impreciso,
corrigindo-se sozinho na leitura seguinte.

## Integração com o servidor central (monitoramento multi-cliente)

Se você atende vários clientes/sites, cada um rodando sua própria instância
deste app, dá pra consolidar o monitoramento num servidor central único
(projeto separado: `cftv-central-server`). Em Configurações → "Servidor
central":

1. No servidor central, cadastre esse site: `npm run criar-cliente -- "Nome do Cliente"`
   — isso gera uma API key única para ele.
2. Aqui no app, ative "Enviar resumo periódico para o servidor central",
   preencha a URL (o IP da máquina do servidor central **dentro da VPN**,
   nunca um IP público) e cole a API key gerada.
3. Clique em "Enviar teste agora" para confirmar que a conexão funciona.

A cada ciclo (padrão 2 minutos, configurável), o app envia um resumo leve:
contagem de câmeras online/offline, o resultado da última auditoria
completa, e a saúde de cada gravador ativo (disco, CPU/memória, e rede se
SNMP estiver configurado) — não é o heartbeat detalhado por câmera, só o
suficiente para o servidor central saber "esse site está saudável ou não"
sem sobrecarregar a rede entre sites. Esse envio roda em paralelo a tudo
mais (heartbeat, auditoria) e não interfere neles.

## Diferenças em relação ao script Python de bancada

| | Script Python (bancada) | App Electron (este) |
|---|---|---|
| Execução | manual via linha de comando | interface gráfica + agendamento embutido |
| Configuração | arquivo `config.json` | tela de cadastro de câmeras |
| Notificação | nenhuma (só relatório .xlsx) | Telegram automático em caso de problema |
| Distribuição | script + dependências Python | instalador `.exe` único |

Ambos usam a mesma lógica conceitual (ONVIF + variância do Laplaciano para
nitidez), então os limiares calibrados em um servem de ponto de partida para
o outro.
