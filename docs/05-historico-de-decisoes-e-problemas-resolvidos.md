# Histórico de Decisões e Problemas Resolvidos

Registro cronológico das decisões técnicas importantes e dos problemas
reais encontrados (e como foram resolvidos) ao longo do desenvolvimento.
Serve como referência para não repetir o mesmo erro nem redescobrir a
mesma solução.

## 1. Origem: script de bancada em Python

O projeto começou como um script Python de linha de comando (ONVIF +
OpenCV) para auditoria semanal manual de ~150 câmeras, gerando um
relatório Excel. Serviu para validar a lógica central (ONVIF para
horário/snapshot, variância do Laplaciano para nitidez) antes de investir
em uma aplicação completa.

## 2. Migração para Electron + TypeScript (não Python + Electron)

Ao decidir empacotar como aplicativo desktop com interface gráfica, a
escolha foi reescrever o núcleo em Node.js/TypeScript em vez de manter
Python como backend com um sidecar. Motivo: um único runtime (Node,
embutido no Electron), instalador mais simples e mais leve, sem precisar
empacotar um interpretador Python inteiro dentro do `.exe`.

## 3. Bug: 62 canais descobertos em vez de 32

**Sintoma**: ao cadastrar um gravador de 32 canais (31 online), o app
descobriu 62 "câmeras". **Causa**: `GetProfiles` (ONVIF) retorna um perfil
por *stream* (principal + substream), não um por canal físico — a
descoberta original não deduplicava. **Correção**: agrupar os perfis pelo
`sourceToken` da `VideoSourceConfiguration` (identifica o canal físico) e
manter apenas o perfil de maior resolução de cada grupo.

## 4. Endpoint ISAPI de status em lote retornou HTTP 404

**Sintoma**: `/ISAPI/ContentMgmt/InputProxy/channels/status` (assumido
como endpoint "todos os canais de uma vez") retornou HTTP 404 num
gravador Intelbras iNVD 3032 real. **Causa**: suposição incorreta — a
documentação oficial da Hikvision (RaCM/ISAPI) só confirma a rota **por
canal**: `/ISAPI/ContentMgmt/InputProxy/channels/{ID}/status`. **Correção**:
lógica em duas tentativas — primeiro tenta a rota em lote (caso algum
firmware suporte), e se falhar, cai para consultas individuais por canal
(ainda leve, um XML pequeno por canal, rodando em paralelo com
concorrência limitada).

## 5. Gravador sem suporte a nenhuma rota ISAPI

**Sintoma**: mesmo após a correção do item 4, um gravador de bancada não
respondeu a nenhuma das duas rotas ISAPI (nem em lote, nem por canal).
**Correção**: adicionada uma terceira camada de fallback — checagem de
disponibilidade do snapshot via ONVIF (`GetSnapshotUri` + HEAD/GET sem
baixar a imagem inteira), que já era usada com sucesso na auditoria manual
para detectar canais com problema (ex: canal desligado propositalmente
detectado corretamente via `HTTP 400` ao tentar buscar o snapshot).

## 6. Cálculo de escala: paralelização entre gravadores

**Contexto**: ao planejar um cenário de 2 gravadores de 128 canais cada,
uma auditoria do código revelou que o heartbeat processava os gravadores
**sequencialmente** (um `for` com `await`), somando o tempo de cada um em
vez de rodar em paralelo. **Correção**: cada gravador passou a ter seu
próprio temporizador independente (`setTimeout` auto-reagendado), rodando
em paralelo com os demais — o tempo total do pior caso passou a ser o
maior entre os gravadores individualmente, não a soma de todos.

## 7. Erro de instalação: `better-sqlite3` exige Python/compilador no Windows

**Sintoma**: `npm install` no servidor central falhou numa máquina Windows
real do cliente, com erro do `node-gyp` (`Could not find any Python
installation to use`), ao tentar compilar o módulo nativo
`better-sqlite3`. **Causa**: módulos nativos Node exigem Python +
compilador C++ (Visual Studio Build Tools) instalados na máquina onde
rodam — nem toda máquina "limpa" tem isso configurado. **Correção**:
substituição de `better-sqlite3` por `lowdb` (JSON puro, 100% JavaScript,
mesma biblioteca já usada no app local), com uma fila de escrita
serializada (`comEscritaSerializada`) para lidar com a escrita concorrente
de vários sites — testado com 10 requisições HTTP simultâneas, todas
salvas corretamente sem perda.

## 8. Scripts npm incompatíveis com `cmd.exe` no Windows

**Sintoma**: `npm run criar-usuario` falhou no Git Bash (MINGW64) com "O
sistema não pode encontrar o caminho especificado", mesmo rodando dentro
do Bash. **Causa**: `npm run` executa scripts via `cmd.exe` por padrão no
Windows (mesmo quando chamado de dentro do Git Bash) — e o script usava
`> /dev/null` (sintaxe Unix), que `cmd.exe` não entende. **Correção**:
remoção do redirecionamento `/dev/null` dos scripts `criar-usuario` e
`criar-cliente` no `package.json` (não era essencial, só escondia a saída
do build).

## 9. Placeholder `<ip>` interpretado como redirecionamento pelo Bash

**Sintoma**: `HOST=<172.17.0.8> PORT=4000 npm start` falhou com
`bash: 172.17.0.8: No such file or directory`. **Causa**: os sinais `<` e
`>` usados na documentação como marcador de "substitua pelo valor real"
foram digitados literalmente no comando — o Bash interpreta `<`/`>` como
redirecionamento de arquivo. **Correção**: nenhuma no código; ajuste na
forma de comunicar exemplos de comando (deixar claro que `<placeholder>`
não deve incluir os sinais de menor/maior ao copiar).

## 10. Bug: campo `snmp` ausente em gravadores cadastrados antes da feature existir

**Sintoma**: `TypeError: Cannot read properties of undefined (reading
'ativo')` ao clicar em "Testar saúde agora" num gravador cadastrado numa
versão anterior do app (antes do campo `snmp` existir no tipo `Gravador`).
**Causa**: registros antigos no `dados.json` local não tinham esse campo;
o código novo assumia que sempre existiria. **Correção**: migração
defensiva no carregamento do banco (`iniciarBanco`) — todo gravador
carregado sem o campo `snmp` recebe um valor padrão automaticamente,
sem precisar remover e recadastrar.

## 11. Descoberta da necessidade de suporte a CGI Dahua

**Contexto**: ao testar coleta de saúde num segundo gravador Intelbras
(diferente do primeiro), nenhum endpoint ISAPI respondeu, mesmo após
atualização de firmware. Isso confirmou que a linha Intelbras mistura
equipamentos derivados de Hikvision (ISAPI) e de Dahua (CGI
`/cgi-bin/...`) — não é um caso isolado. **Correção**: implementada
detecção automática de protocolo (probe ISAPI → probe CGI Dahua → cache
no cadastro do gravador) e um coletor de disco específico para o formato
de resposta do CGI Dahua (texto chave=valor, não XML). Ver documento 04
para os detalhes técnicos e o status de validação (parser ainda não
testado contra hardware Intelbras real).

## 12. Logo do app: artefato branco opaco escondido na imagem original

**Sintoma**: ao recortar o símbolo da marca para gerar o ícone do app, uma
área aparentemente vazia (branca) na imagem original continha pixels
**opacos** brancos (não transparentes) — invisíveis contra o fundo branco
do visualizador de imagem, mas que apareceriam como uma mancha branca
contra o fundo escuro da barra lateral do app. **Correção**: qualquer
pixel próximo do branco puro (mesmo que opaco) foi convertido para
totalmente transparente antes de gerar os ícones finais.
