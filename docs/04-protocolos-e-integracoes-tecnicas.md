# Protocolos e Integrações Técnicas

Referência técnica de todos os protocolos usados para falar com câmeras e
gravadores CFTV, e o padrão de design (camadas em cascata com fallback
gracioso) usado de forma consistente em várias partes do sistema.

## Padrão de design: camadas em cascata com fallback gracioso

Repetido em três lugares diferentes do sistema, sempre com a mesma lógica:
tenta o método mais leve/eficiente primeiro; se o dispositivo não suportar
(erro, HTTP 404, timeout), cai automaticamente para o próximo método, mais
pesado porém mais compatível; só desiste de verdade quando todas as
camadas falharem. Cada camada falhando não derruba as outras.

- **Conectividade de canal de gravador**: ISAPI em lote → ISAPI por canal
  → ONVIF por canal (snapshot) → TCP no gravador como um todo.
- **Disco do gravador**: ISAPI → CGI Dahua → SNMP genérico
  (HOST-RESOURCES-MIB).
- **Detecção de fabricante/protocolo**: probe ISAPI → probe CGI Dahua →
  marca como "nenhum" (com nova tentativa automática no próximo ciclo).

## ONVIF (Profile S / T / G)

Protocolo padrão da indústria, usado como camada de abstração comum a
câmeras/gravadores de qualquer marca. Operações usadas no sistema:

- **`GetProfiles`**: descobre os canais/streams disponíveis num gravador.
  **Detalhe importante**: retorna tipicamente DOIS perfis por canal físico
  (stream principal + substream). A deduplicação correta é feita agrupando
  pelo `sourceToken` da `VideoSourceConfiguration` de cada perfil (que
  identifica o canal físico de verdade) e mantendo o perfil de maior
  resolução (`videoEncoderConfiguration.resolution.width × height`) de
  cada grupo. Sem essa deduplicação, um gravador de 32 canais aparece
  incorretamente com 62 canais descobertos.
- **`GetSnapshotUri`**: obtém a URL do snapshot de um perfil/canal
  específico (usando `profileToken` para garantir que pega o canal certo,
  não sempre o canal 1).
- **`GetSystemDateAndTime`**: consulta o relógio do dispositivo, para
  comparar com a referência NTP.
- **`SetSystemDateAndTime`** (modo `Manual`): ajusta o relógio do
  dispositivo diretamente para o horário que o app já obteve via NTP —
  mais confiável que configurar o dispositivo para sincronizar sozinho com
  um NTP externo, pois não depende dele alcançar esse servidor.

A biblioteca Node usada é `onvif` (pacote npm), 100% JavaScript.

## ISAPI (família Hikvision, boa parte da linha Intelbras)

Protocolo HTTP+XML (autenticação Digest) da Hikvision, também usado por
diversos OEMs (incluindo parte da Intelbras).

### Endpoints usados e como foram confirmados

- **Status de canal em lote**: `/ISAPI/ContentMgmt/InputProxy/channels/status`
  — **tentativa inicial que falhou com HTTP 404** num gravador real
  (Intelbras iNVD 3032). A documentação oficial da Hikvision (RaCM/ISAPI)
  não confirma uma rota "todos os canais de uma vez" garantida.
- **Status de canal individual** (rota oficialmente documentada):
  `/ISAPI/ContentMgmt/InputProxy/channels/{ID}/status` — corrigido após o
  erro acima; funciona por canal, ainda leve (XML pequeno).
- **Disco (HDD)**: `/ISAPI/ContentMgmt/Storage` — retorna
  `<storage><hddList><hdd><id>/<hddName>/<status>/<capacity>/<freeSpace>...`;
  `capacity`/`freeSpace` em MB.
- **CPU/memória**: `/ISAPI/System/status` — campos
  `<cpuUtilization>`, `<memoryUsage>`, `<memoryAvailable>`.
- **Probe de detecção de fabricante**: `/ISAPI/System/deviceInfo` (só
  testa se o dispositivo responde, não processa o corpo).

Parsing feito com regex simples e tolerante em vez de um parser XML
completo (estrutura varia levemente entre firmwares/fabricantes, mas os
campos usados são consistentes na prática).

## CGI Dahua (outra parte da linha Intelbras, além de Dahua "puro")

Descoberto como necessário depois que **outro gravador Intelbras** (além
do primeiro testado) também não respondeu a nenhum endpoint ISAPI, mesmo
após atualização de firmware — evidência de que a linha Intelbras mistura
equipamentos derivados de plataformas diferentes (Hikvision-ISAPI e
Dahua-CGI).

- **Detecção de fabricante**: `/cgi-bin/magicBox.cgi?action=getVendor` —
  resposta em texto plano `vendor=<Nome>`.
- **Disco**: `/cgi-bin/magicBox.cgi?action=getDeviceAllInfo` — resposta em
  texto plano chave=valor (não XML), formato
  `list[N].Detail[0].TotalBytes=...` / `list[N].Detail[0].UsedBytes=...` /
  `list[N].State=...`, um bloco `list[N]` por HDD físico. Conversão para
  GB feita dividindo por 1024³ (bytes → GiB).

**Status de validação**: o parser segue a documentação oficial do
protocolo Dahua HTTP API v2.0, mas **ainda não foi testado contra um
gravador Intelbras real** no momento desta documentação — é esperado que
pequenos ajustes sejam necessários, no mesmo padrão do que já aconteceu
com o endpoint de status de canal do ISAPI.

**CPU/memória via CGI Dahua**: não implementado. Não foi encontrado um
endpoint documentado com confiabilidade equivalente ao de disco, e a
decisão do projeto foi não adivinhar um endpoint sem validação (depois de
já ter acertado esse tipo de suposição errada duas vezes com o ISAPI).

## SNMP

Usado como fallback genérico, independente de fabricante — mas só funciona
se o agente SNMP do equipamento implementar a MIB específica necessária
(nem todo firmware embarcado implementa tudo).

- **Rede (consumo/tráfego)**: `IF-MIB`, contadores
  `ifHCInOctets`/`ifHCOutOctets` (64 bits, OID
  `1.3.6.1.2.1.31.1.1.1.6`/`.10`), com fallback automático para
  `ifInOctets`/`ifOutOctets` (32 bits, OID `1.3.6.1.2.1.2.2.1.10`/`.16`)
  quando os de 64 bits não são suportados. O cálculo faz DUAS leituras dos
  contadores com um intervalo entre elas (padrão 1 segundo) e calcula a
  taxa (bytes/segundo → Mbps) pela diferença. Não existe endpoint ISAPI
  padronizado para tráfego real — só para velocidade nominal do link, que
  é uma métrica diferente.
  - **Limitação conhecida**: contadores de 32 bits podem estourar (wrap)
    em poucos minutos num link gigabit sob carga muito alta. O código
    trata isso matematicamente (módulo do limite do contador), mas no
    instante exato do estouro uma leitura pode sair imprecisa,
    corrigindo-se sozinha na leitura seguinte.
- **Disco (fallback de última instância)**: `HOST-RESOURCES-MIB::hrStorageTable`
  (OID base `1.3.6.1.2.1.25.2.3.1`), filtrando linhas do tipo
  `hrStorageFixedDisk` (OID `1.3.6.1.2.1.25.2.1.4`) para não contar
  memória RAM/swap que também aparece nessa tabela. Implementado via
  `subtree()` (varredura da subárvore SNMP), parseando o índice de
  coluna/linha a partir do OID retornado.

Biblioteca usada: `net-snmp` (pacote npm), 100% JavaScript — confirmado
sem dependências nativas antes de adotar (mesma preocupação que motivou
trocar `better-sqlite3` por `lowdb`).

## Ajuste de horário em lote — deduplicação por gravador

Canais vindos do mesmo gravador compartilham o relógio físico do NVR.
Tanto na correção de horário quanto na coleta de saúde, o sistema agrupa
por gravador (ou, no caso de câmeras individuais, por câmera) antes de
disparar comandos de rede, para nunca repetir a mesma operação uma vez por
canal quando uma vez por dispositivo físico já resolve.
