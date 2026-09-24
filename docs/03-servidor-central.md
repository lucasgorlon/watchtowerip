# Servidor Central (projeto `cftv-central-server`)

Serviço Node.js/Express que recebe relatórios periódicos de cada app local
(site/cliente), guarda histórico, e serve uma API para o futuro dashboard
web com login. Pensado para rodar **dentro da malha VPN** que interliga os
clientes, sem exposição à internet pública.

## Estrutura de módulos

```
src/
  index.ts          servidor Express (entrypoint)
  db.ts              armazenamento (lowdb/JSON) + fila de escrita serializada
  auth.ts            hash de senha (scrypt nativo do Node), sessões, API keys
  clientesRepo.ts     acesso a dados: clientes e relatórios
  middlewares.ts      exigirSessao (dashboard) / exigirApiKey (sites)
  routes/
    auth.ts            POST /api/auth/login, /logout, GET /me
    relatorios.ts       POST /api/relatorios  (sites enviam aqui)
    clientes.ts         GET /api/clientes, /:id, /:id/historico (dashboard)
  cli/
    criarUsuario.ts     cria o usuário de login do dashboard
    criarCliente.ts      cadastra um site e gera a API key dele
```

## Modelo de dados

- **Clientes**: id, nome, apiKey (única, gerada na criação), criadoEm,
  ultimoRelatorioEm, ultimoRelatorioResumo (cache do último estado
  conhecido, para leitura rápida sem varrer o histórico).
- **Relatórios**: histórico append-only por cliente, podado
  automaticamente para manter só os últimos 500 por cliente.
- **Usuários do dashboard**: usuário + hash de senha (scrypt).
- **Sessões**: token opaco, expiração de 12 horas.

## Autenticação — dois mecanismos com propósitos diferentes

- **API key** (header `X-Api-Key`): usada pelos apps locais para enviar
  relatórios. Uma por cliente, gerada e exibida uma única vez na criação
  (`npm run criar-cliente`). Nunca é devolvida em endpoints de leitura do
  dashboard.
- **Sessão por cookie** (login usuário/senha): usada pelo dashboard web
  (ainda não construído) para ler os dados. Cookie `httpOnly` +
  `SameSite=Strict`. Sem flag `Secure` propositalmente, pois o servidor
  roda em HTTP simples dentro da VPN (sem TLS público).

## Endpoints da API

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/saude` | nenhuma | health-check simples |
| POST | `/api/auth/login` | — | login do dashboard, define cookie de sessão |
| POST | `/api/auth/logout` | sessão | encerra a sessão |
| GET | `/api/auth/me` | sessão | confirma quem está logado |
| POST | `/api/relatorios` | API key | site envia o resumo periódico |
| GET | `/api/clientes` | sessão | lista todos os clientes (sem expor apiKey) |
| GET | `/api/clientes/:id` | sessão | detalhe de um cliente |
| GET | `/api/clientes/:id/historico` | sessão | histórico de relatórios daquele cliente |

## Formato do relatório aceito (`POST /api/relatorios`)

```json
{
  "totalCameras": 32,
  "online": 30,
  "offline": 2,
  "desconhecido": 0,
  "ultimaAuditoria": {
    "dataHoraFim": "2026-09-14T20:00:00Z",
    "ok": 28, "atencao": 2, "offline": 2, "manual": 0
  },
  "saudeGravadores": [
    { "gravadorId": "...", "nome": "NVR Recepção", "discoTotalGb": 4000, "discoLivreGb": 512, "redeMbps": 12.4 }
  ]
}
```

Só `totalCameras`, `online`, `offline` e `desconhecido` são obrigatórios;
`ultimaAuditoria` e `saudeGravadores` são opcionais.

## Por que lowdb (JSON puro) em vez de SQLite

A primeira versão usava `better-sqlite3`, que exige compilar um módulo
nativo (Python + compilador C++) na máquina onde roda o `npm install` —
isso quebrou a instalação numa máquina Windows "limpa" do cliente com erro
de `node-gyp`/Python ausente (ver documento 05 para o relato completo).
Como este servidor precisa rodar em qualquer máquina disponível na
rede/VPN do cliente (não necessariamente preparada para desenvolvimento),
a solução foi trocar para `lowdb` — mesma biblioteca já usada no app local,
100% JavaScript, sem compilação nativa.

**Concorrência**: como vários sites podem enviar relatório quase ao mesmo
tempo, a escrita no arquivo JSON é serializada por uma fila
(`comEscritaSerializada` em `db.ts`) — cada gravação espera a anterior
terminar. Testado com 10 requisições HTTP concorrentes: todas as 10 foram
salvas corretamente, sem perda por condição de corrida.

## Hospedagem e segurança de rede

O servidor deve rodar **dentro da malha VPN**, nunca exposto à internet
pública. A variável de ambiente `HOST` controla em qual interface de rede
o Express escuta:

```bash
HOST=<ip-da-interface-vpn-desta-maquina> PORT=4000 npm start
```

Sem definir `HOST`, o servidor sobe em `127.0.0.1` (só acessível
localmente — seguro por padrão, mas inútil para os sites remotos). Nunca
usar `0.0.0.0`, que exporia o serviço em qualquer interface, incluindo uma
eventual saída para a internet.

## Impacto de tráfego pela VPN (calculado no projeto)

Com o payload atual (resumo agregado, ~185 bytes de JSON + ~450 bytes de
overhead HTTP ≈ 635 bytes por requisição): 6 clientes no intervalo padrão
de 2 minutos geram ~112 KB/hora de tráfego total pela VPN (~32 bytes/segundo
em média). Mesmo num cenário extremo de intervalo de 15 segundos (bem mais
agressivo que o necessário), o total fica abaixo de 1 MB/hora. O tamanho do
payload **não escala** com a quantidade de canais/câmeras do cliente — é
sempre um resumo agregado, nunca um dado por câmera.

## CLIs disponíveis

```bash
npm install
npm run build

npm run criar-usuario -- <usuario> <senha>     # usuário de login do dashboard (senha mín. 8 caracteres)
npm run criar-cliente -- "<Nome do Cliente>"   # cadastra um site e imprime a API key gerada
npm start                                        # sobe o servidor (respeita HOST/PORT)
```

## Manutenção

O arquivo de dados fica em `data/central.json` (criado automaticamente).
Deve ter backup periódico — é toda a memória do servidor (clientes, API
keys, histórico). O histórico é podado automaticamente (últimos 500
relatórios por cliente).

## Pendente

O dashboard web visual com login ainda não foi construído — a API já está
pronta para ele (`GET /api/clientes`, `GET /api/clientes/:id/historico`,
fluxo de login/sessão já funcional e testado).
