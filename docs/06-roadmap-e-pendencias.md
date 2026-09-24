# Roadmap e Pendências

## Pronto e funcionando

**App local (`cftv-audit-app`)**
- Cadastro de gravador com descoberta automática de canais via ONVIF
  (deduplicação main/substream).
- Cadastro de câmera individual.
- Heartbeat de conectividade automático, paralelizado entre gravadores,
  com intervalo adaptativo e 4 camadas de fallback (ISAPI lote → ISAPI
  por canal → ONVIF por canal → TCP no gravador).
- Auditoria completa manual (horário + qualidade de imagem), com filtros
  configuráveis e agendamento cron.
- Pausa automática do heartbeat durante auditoria/correção manual.
- Correção de horário em lote via ONVIF, com deduplicação por gravador.
- Coleta de saúde do gravador: disco (ISAPI → CGI Dahua → SNMP), CPU/memória
  (ISAPI), rede (SNMP), com detecção automática de fabricante/protocolo.
- Notificações Telegram (mudança de estado de conectividade + resumo de
  auditoria com problemas).
- Envio periódico de resumo ao servidor central.
- Identidade visual (ícone/logo aplicados).

**Servidor central (`cftv-central-server`)**
- API de recebimento de relatórios (autenticação por API key).
- Autenticação de sessão para dashboard (login/logout, ainda sem
  interface visual).
- Armazenamento em JSON com escrita concorrente segura (fila serializada,
  testada).
- CLIs de administração (criar usuário, criar cliente).
- Cálculo de impacto de rede validado (tráfego irrelevante mesmo em
  cenários grandes).

## Pendente

1. **Dashboard web com login** — interface visual consumindo
   `GET /api/clientes` e `GET /api/clientes/:id/historico`, com tela de
   login batendo em `POST /api/auth/login`. A API já está pronta; falta
   só a camada visual. Prioridade discutida: item mais visível para o
   integrador acompanhar os 6 clientes num só lugar.

2. **CPU/memória para gravadores da família Dahua/CGI** — hoje só
   implementado para a família ISAPI. Não foi encontrado (ainda) um
   endpoint Dahua CGI documentado com confiabilidade equivalente ao de
   disco; decisão consciente de não adivinhar sem validação.

3. **Hardening do app local para rodar em estação de trabalho de uso
   diário** — discutido como cenário possível (máquina do funcionário do
   cliente, não um mini-PC dedicado). Pontos levantados que ainda não
   foram implementados:
   - Rodar minimizado na bandeja do sistema (hoje fechar a janela encerra
     o processo inteiro).
   - Início automático com o Windows (hoje não volta sozinho após reinício).
   - Evitar que a suspensão/sono da máquina pause o monitoramento sem
     aviso.
   - Criptografar credenciais salvas localmente (câmeras, gravadores,
     token do Telegram) usando `safeStorage` do Electron, em vez de texto
     puro.

4. **Canais de notificação WhatsApp e E-mail** — arquitetura plugável já
   pronta (`Notifier` interface, `notifiers/index.ts` já detecta
   automaticamente qualquer canal configurado). Implementação real
   pendente. Para WhatsApp, os dois caminhos recomendados (documentados
   no código) são a Meta Cloud API oficial ou um provedor como Twilio —
   evitar bibliotecas não-oficiais baseadas em WhatsApp Web (risco de
   bloqueio de número).

5. **Validação de campo do parser Dahua CGI** — o parser de disco via CGI
   Dahua segue a documentação oficial do protocolo, mas ainda não foi
   testado contra um gravador Intelbras real. É esperado (com base no
   histórico do projeto — ver documento 05) que pequenos ajustes de
   formato sejam necessários após o primeiro teste real.

## Decisões em aberto (para revisitar quando chegar a hora)

- Onde hospedar fisicamente o servidor central dentro da malha VPN de
  produção (decisão já tomada de mantê-lo interno à VPN, sem exposição
  pública — falta decidir a máquina/local específico em cada implantação).
- Se/quando vale a pena adicionar TLS interno ao servidor central (hoje
  roda em HTTP simples, justificado pelo tráfego já estar dentro de uma
  VPN confiável).
- Prioridade entre "dashboard web" e "hardening de workstation" depende do
  próximo cliente a receber o sistema em produção — se for um site sem
  máquina dedicada, hardening vira prioridade; se o foco for consolidar
  visibilidade dos 6 clientes já monitorados, dashboard vira prioridade.
