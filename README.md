# Auditoria CFTV — Monorepo

Sistema de auditoria/monitoramento CFTV multi-cliente para integradores:
verificação automática de conectividade, horário e qualidade de imagem de
câmeras/gravadores, com notificação em tempo real e consolidação
multi-site via servidor central.

Composto por dois aplicativos independentes, organizados como *workspaces*
npm neste monorepo:

```
apps/
  cftv-audit-app/       App desktop (Electron + TypeScript) — roda em cada site do cliente
  cftv-central-server/  Servidor central (Node/Express) — agrega relatórios de todos os sites via VPN
docs/                   Documentação técnica completa do projeto (arquitetura, protocolos,
                        histórico de decisões, roadmap) — também usada como fonte para o NotebookLM
```

Cada app tem seu próprio `README.md` com instruções detalhadas de
instalação, configuração e build:

- [`apps/cftv-audit-app/README.md`](apps/cftv-audit-app/README.md)
- [`apps/cftv-central-server/README.md`](apps/cftv-central-server/README.md)

## Documentação

A pasta `docs/` contém a documentação de referência do projeto inteiro,
organizada em documentos independentes:

| Arquivo | Conteúdo |
|---|---|
| `01-visao-geral-e-arquitetura.md` | Contexto, os dois componentes, por que essa arquitetura |
| `02-app-local-auditoria-cftv.md` | App Electron em detalhe |
| `03-servidor-central.md` | Servidor Node/Express em detalhe |
| `04-protocolos-e-integracoes-tecnicas.md` | ONVIF / ISAPI / CGI Dahua / SNMP |
| `05-historico-de-decisoes-e-problemas-resolvidos.md` | Decisões técnicas e bugs reais já resolvidos |
| `06-roadmap-e-pendencias.md` | O que está pronto e o que falta |
| `00-prompt-de-aplicacao-notebooklm.md` | Prompt para usar esses documentos como fonte no NotebookLM |

## Instalação (monorepo inteiro)

```bash
npm install
```

O `npm install` na raiz resolve as dependências dos dois workspaces de
uma vez (`apps/cftv-audit-app` e `apps/cftv-central-server`).

## Comandos rápidos (a partir da raiz)

```bash
npm run start:app          # roda o app local em modo desenvolvimento
npm run start:server       # sobe o servidor central (respeita HOST/PORT)
npm run build:app          # compila só o app local
npm run build:server       # compila só o servidor central
npm run dist:app:win       # gera o instalador .exe do app local

npm run criar-usuario -- admin "senha-aqui"        # cria usuário do dashboard no servidor central
npm run criar-cliente -- "Nome do Cliente"         # cadastra um site/cliente e gera a API key dele
```

Também é possível rodar cada app isoladamente entrando na sua pasta
(`cd apps/cftv-audit-app && npm start`, por exemplo) — os workspaces npm
não obrigam a usar os atalhos da raiz.

## Segurança — antes de tornar o repositório público

Este projeto lida com credenciais de câmeras/gravadores e API keys de
clientes. Antes de qualquer `git push`:

- Confirme que `.gitignore` está excluindo `apps/cftv-central-server/data/*.json`
  (onde ficam API keys e hash de senhas do servidor central) e qualquer
  arquivo `.env`.
- Nunca commite IPs reais de clientes, tokens de Telegram ou API keys —
  os exemplos nos READMEs usam placeholders de propósito.
- Se o repositório for público, revise o histórico de commits antes do
  primeiro push (não depois) — remover segredos de um histórico já
  publicado é bem mais trabalhoso do que não commitá-los.
