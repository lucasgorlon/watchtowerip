# Servidor Central — Auditoria CFTV (multi-cliente)

Servidor que recebe relatórios periódicos dos apps locais (um por site/cliente)
via VPN, guarda o histórico, e serve uma API para um futuro dashboard web com
login. Este é o **primeiro pedaço** da arquitetura multi-cliente — a base
sobre a qual o dashboard visual será construído a seguir.

Pensado para rodar **dentro da malha VPN**, sem exposição à internet pública.

## Por que lowdb (JSON puro) em vez de SQLite

A primeira versão deste servidor usava `better-sqlite3`. Na prática, isso
exige compilar um módulo nativo na máquina onde o `npm install` roda — o que
requer Python e um compilador C++ instalados. Em máquinas Windows "limpas"
(sem essas ferramentas de desenvolvimento já configuradas), isso quebra a
instalação com um erro de `node-gyp`. Como este servidor deve rodar em
qualquer máquina disponível na rede/VPN do cliente — não necessariamente uma
máquina preparada para desenvolvimento — trocamos para `lowdb` (mesma
biblioteca usada no app Electron local): 100% JavaScript, sem compilação
nativa, `npm install` funciona em qualquer lugar que tenha Node.js.

**Sobre escrita concorrente** (o motivo original de termos escolhido SQLite):
como vários sites podem enviar relatório quase ao mesmo tempo, o acesso ao
arquivo JSON é serializado por uma fila de escrita em `db.ts`
(`comEscritaSerializada`) — cada gravação espera a anterior terminar antes de
começar, evitando que duas escritas simultâneas se sobrescrevam. Testado com
10 requisições concorrentes: todas as 10 foram salvas corretamente, sem
perda.

## Arquitetura desta peça

```
src/
  index.ts          servidor Express (entrypoint)
  db.ts              armazenamento (lowdb/JSON) + fila de escrita serializada
  auth.ts            hash de senha (scrypt nativo), sessões, API keys
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

**Duas formas de autenticação, propósitos diferentes:**
- **API key** (header `X-Api-Key`) — usada pelos apps locais (sites) para
  enviar relatórios. Uma por cliente, gerada na hora do cadastro.
- **Sessão por cookie** (login usuário/senha) — usada pelo dashboard web
  (ainda não construído) para ler os dados. `httpOnly` + `SameSite=Strict`.

## Instalação e primeiro uso

```bash
npm install
npm run build

# cria o usuário que vai logar no dashboard (senha minimo 8 caracteres)
npm run criar-usuario -- admin "sua-senha-aqui"

# cadastra cada cliente/site e recebe a API key dele
npm run criar-cliente -- "Nome do Cliente 1"
# ... repita para os outros 5 clientes
```

Cada API key impressa deve ser colada na configuração do app local
correspondente (isso entra numa próxima etapa: o app Electron ainda precisa
do módulo que envia os relatórios — ver "Próximos passos" abaixo).

## Rodando o servidor

```bash
HOST=<ip-da-interface-vpn-desta-maquina> PORT=4000 npm start
```

**`HOST` é a parte mais importante para a segurança deste serviço.** Se você
não definir `HOST`, o servidor sobe em `127.0.0.1` (só acessível da própria
máquina — inútil para os sites remotos, mas seguro por padrão). Para os apps
locais conseguirem enviar relatórios pela VPN, defina `HOST` como o IP que
essa máquina tem **na interface VPN** (não `0.0.0.0`, que exporia o serviço
em qualquer interface de rede, incluindo uma eventual saída para a internet).

## Testando rapidamente

```bash
# saude
curl http://<host>:4000/api/saude

# login (salva cookie de sessao)
curl -c cookies.txt -X POST http://<host>:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"usuario":"admin","senha":"sua-senha-aqui"}'

# listar clientes (usa a sessao)
curl -b cookies.txt http://<host>:4000/api/clientes

# simular um site enviando relatorio
curl -X POST http://<host>:4000/api/relatorios \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <api-key-do-cliente>" \
  -d '{"totalCameras":32,"online":30,"offline":2,"desconhecido":0}'
```

## Formato do relatório (o que o app local deve enviar)

```json
{
  "totalCameras": 32,
  "online": 30,
  "offline": 2,
  "desconhecido": 0,
  "ultimaAuditoria": {
    "dataHoraFim": "2026-09-14T20:00:00Z",
    "ok": 28,
    "atencao": 2,
    "offline": 2,
    "manual": 0
  },
  "saudeGravadores": [
    { "gravadorId": "...", "nome": "NVR Recepção", "discoTotalGb": 4000, "discoLivreGb": 512, "redeMbps": 12.4 }
  ]
}
```

`ultimaAuditoria` e `saudeGravadores` são opcionais — o servidor já aceita e
guarda esses campos, prontos para quando a coleta de saúde do gravador
(HDD via ISAPI, rede via SNMP) for implementada no app local. Até lá, o app
pode enviar só os 4 campos obrigatórios (totalCameras/online/offline/desconhecido).

## Próximos passos (fora do escopo desta etapa)

1. **App local → servidor central**: adicionar um módulo no app Electron que
   monta esse payload a partir do estado já salvo (`store.ts`) e faz um POST
   periódico para cá, com a URL e a API key configuráveis em Configurações.
2. **Coleta de saúde do gravador**: HDD via ISAPI, rede via SNMP, incluindo
   no payload de relatório.
3. **Dashboard web**: interface visual consumindo `/api/clientes` e
   `/api/clientes/:id/historico`, com a própria tela de login batendo em
   `/api/auth/login`.

## Manutenção do banco

O arquivo de dados fica em `data/central.json` (criado automaticamente). Faça
backup periódico desse arquivo — ele é toda a memória do servidor central
(clientes, API keys e histórico de relatórios). O histórico é podado
automaticamente para manter só os últimos 500 relatórios por cliente.
