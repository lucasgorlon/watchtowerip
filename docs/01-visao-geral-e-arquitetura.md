# Visão Geral e Arquitetura — Sistema de Auditoria/Monitoramento CFTV

## Contexto e problema original

O responsável pelo projeto é um integrador que atende múltiplos clientes
(cenário de referência usado ao longo do desenvolvimento: 6 clientes),
cada um com seu próprio circuito fechado de CFTV — variando de câmeras
avulsas a múltiplos gravadores (NVRs) de até 128-300+ canais, de marcas
diferentes (Hikvision, Dahua, Intelbras, Uniview, TVT).

O problema inicial: a verificação manual, câmera por câmera, de horário
correto e qualidade de imagem (lente suja/desfocada) era feita pelo menos
uma vez por semana em ~150 câmeras, de forma totalmente manual. O pedido
original foi "existe uma ferramenta ou agente inteligente que automatize
isso?" — e a resposta evoluiu, ao longo do projeto, para um sistema
completo inspirado na arquitetura do Zabbix: **agente local por site +
servidor central agregador + (futuro) dashboard web**.

## Os dois componentes do sistema

### 1. App local — "Auditoria CFTV" (projeto `cftv-audit-app`)

Aplicativo desktop (Electron + TypeScript), instalado **em cada site do
cliente**, rodando continuamente. Responsável por:

- Verificação de conectividade em tempo quase real (heartbeat).
- Auditoria completa sob demanda (horário + qualidade de imagem).
- Correção de horário em lote.
- Coleta de saúde dos gravadores (disco, CPU/memória, rede).
- Notificação imediata via Telegram quando algo muda de estado.
- Envio periódico de um resumo agregado para o servidor central.

Detalhes completos no documento `02-app-local-auditoria-cftv.md`.

### 2. Servidor central (projeto `cftv-central-server`)

Serviço Node.js/Express que roda **dentro da malha VPN** que interliga os
sites do cliente (sem exposição à internet pública). Recebe os resumos
periódicos enviados por cada app local, guarda histórico, e expõe uma API
que um futuro dashboard web (com login) vai consumir para mostrar todos os
clientes num só lugar.

Detalhes completos no documento `03-servidor-central.md`.

## Por que essa arquitetura (agente local + hub central) e não um "poller" 100% centralizado

Uma alternativa considerada foi um único servidor central se conectando
direto em cada gravador de cada cliente via VPN, sem precisar de nenhum
app rodando localmente em cada site. Essa alternativa foi descartada em
favor do modelo agente+hub pelos seguintes motivos:

- **Resiliência a queda de VPN**: com o app local, se a VPN cair, o site
  continua monitorando a si mesmo e notificando via Telegram normalmente —
  só o dashboard central fica com aquele site "desatualizado" até a VPN
  voltar. No modelo 100% centralizado, uma queda de VPN pareceria
  (erradamente) "todas as câmeras daquele cliente caíram".
- **Tráfego pela VPN é mínimo por design**: o que cruza a VPN é só um
  resumo agregado (contagens + saúde dos gravadores), não o tráfego
  detalhado de heartbeat por câmera. Cálculo feito no projeto: ~112 KB/hora
  de tráfego total para 6 clientes no intervalo padrão de envio (2 min) —
  irrelevante para qualquer link de VPN, mesmo um modesto.
- **O trabalho pesado fica local**: toda a checagem ONVIF/ISAPI/SNMP por
  canal, download de snapshot para auditoria de imagem, etc., acontece
  dentro da rede local de cada cliente — nunca atravessa a VPN.

## Stack tecnológica

- **App local**: Electron + TypeScript, sem módulos nativos (só
  bibliotecas 100% JavaScript) — decisão deliberada para simplificar a
  geração do instalador Windows a partir de qualquer sistema operacional
  (ver documento 05 para o histórico do problema que essa escolha evitou).
- **Servidor central**: Node.js + Express + TypeScript, armazenamento em
  JSON puro via `lowdb` (mesma lógica de "sem módulo nativo" do app local).
- **Protocolos de integração com câmeras/gravadores**: ONVIF (Profile
  S/T/G), ISAPI (Hikvision/Intelbras), CGI Dahua (`/cgi-bin/...`, outra
  parte da linha Intelbras), SNMP (IF-MIB para rede, HOST-RESOURCES-MIB
  para disco). Detalhes técnicos completos no documento
  `04-protocolos-e-integracoes-tecnicas.md`.
- **Notificação**: Telegram (Bot API), com arquitetura plugável já
  preparada para WhatsApp e E-mail no futuro.

## Diagrama textual da arquitetura

```
[Cliente 1: câmeras/gravadores] <--LAN--> [App local (Electron)] --\
[Cliente 2: câmeras/gravadores] <--LAN--> [App local (Electron)] ---\
[Cliente 3: câmeras/gravadores] <--LAN--> [App local (Electron)] ----+--VPN--> [Servidor central (Node/Express)] --> [Futuro: Dashboard web com login]
[Cliente ...]                                                       |
[Cliente 6: câmeras/gravadores] <--LAN--> [App local (Electron)] --/
```

Cada app local também dispara alertas Telegram diretamente, de forma
independente do servidor central — o Telegram não depende da VPN nem do
servidor central estar no ar.

## Estado do projeto no momento desta documentação

**Pronto e funcionando**: app local completo (heartbeat, auditoria,
correção de horário, saúde de gravador com detecção automática de
fabricante, notificação Telegram, envio ao servidor central); servidor
central completo (API de recebimento, autenticação dupla, CLIs de
administração).

**Pendente**: dashboard web visual com login (o servidor central já expõe
a API pronta para isso); coleta de CPU/memória para gravadores da família
Dahua/Intelbras-CGI (só disco foi resolvido para essa família até agora);
hardening do app local para rodar em estação de trabalho de uso diário
(bandeja do sistema, início automático, prevenção de suspensão,
criptografia de credenciais salvas); canais de notificação WhatsApp e
E-mail (estrutura pronta, implementação pendente).

Detalhes no documento `06-roadmap-e-pendencias.md`.
