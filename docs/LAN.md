# Entre computadores

A tela **Computadores** do app manda arquivos direto para outro computador pela rede local: um da sua conta SOBEDESCE
ou o de quem está do lado com outra conta (o editor que precisa do material na mídia dele e no Drive dele). Funciona
entre Mac e Windows, nos dois sentidos, e serve como "AirDrop" da produtora.

## Como usar

1. No computador que vai **receber**, ligue **Este computador recebe**.
   - Os arquivos chegam em `~/SOBEDESCE Recebidos`. Dá para trocar a pasta.
2. No computador que vai **mandar**:
   - escolha o computador na lista;
   - escolha os arquivos ou a pasta (ou arraste);
   - dê o nome da **pasta no destino**.
3. Opcional: **Subir pro Drive ao mesmo tempo** põe os mesmos arquivos na fila de Transferências, na pasta do Drive que
   você escolher.
4. **Mandar.** A tela mostra a porcentagem, a velocidade agora e a média, o tempo restante e um gráfico.
   - No outro computador aparece **Chegando aqui** e um aviso quando termina.

Os dois precisam estar na mesma rede (Wi-Fi ou cabo) e com o SOBEDESCE aberto.

## Para outra conta (quem está do lado)

1. Quem vai **receber** liga **Este computador recebe** e **Aceitar de outras contas por perto**.
2. Quem vai **mandar** vê o computador em **Por perto, de outras contas** (nome do computador e primeiro nome do dono).
3. Ao mandar, aparece para quem recebe um pedido com quem manda, quantos arquivos, o tamanho e a pasta:
   - **Aceitar** começa a cópia. Com **Subir pro meu Drive quando chegar**, a pasta recebida entra na fila de
     Transferências **da conta de quem recebeu**, na pasta do Drive que essa pessoa escolheu.
   - **Recusar** encerra; quem mandou vê "X recusou o envio."
   - Sem resposta em 5 min, o pedido cai. No máximo 3 pedidos esperando ao mesmo tempo.
4. O "Subir pro Drive ao mesmo tempo" de quem manda continua indo para a conta de quem manda.

**Por perto** quer dizer: mesmo IP público (IPv4) ou mesmo /64 (IPv6) na hora do aviso, com o computador online nos
últimos 3 min. O site guarda só um HMAC da rede, nunca o IP.

## Organização no destino

- Uma pasta só: o conteúdo dela vai direto para `<pasta de recebidos>/<pasta no destino>/`, com as subpastas.
- Várias pastas ou arquivos soltos: cada pasta entra com o nome dela dentro da pasta no destino.
- O que já está lá com o mesmo caminho e o mesmo tamanho não vai de novo.
- Um arquivo com o mesmo nome e outro conteúdo não é sobrescrito: o novo chega como `nome (2).ext`.
- A data de modificação de cada arquivo é mantida.

## Segurança

- **Achar o outro computador:**
  - Cada computador com a recepção ligada avisa o site a cada minuto (`POST /api/lan/presenca`) com os endereços da
    rede local, a porta e a **chave de recepção**.
  - A chave tem 32 bytes, é sorteada uma vez e fica em `<dados>/lan.json`. No banco do site ela fica selada com
    AES-256-GCM e `SOBEDESCE_KEY`.
  - Só os computadores da mesma conta recebem a chave (`GET /api/lan/computadores`, só sessão de dispositivo). O site e
    o celular não recebem.
- **Outras contas:**
  - Cada computador tem também um par **X25519** (em `lan.json`, só para o usuário do sistema). A pública vai no aviso
    de presença junto com `outros: true` quando a pessoa liga "Aceitar de outras contas por perto".
  - `GET /api/lan/proximos` (só sessão de dispositivo) devolve, para outra conta na mesma rede: nome, primeiro nome do
    dono, endereços, porta e a **chave pública**. A chave de recepção nunca sai da conta.
  - Quem manda sorteia um par só para aquele envio, combina (ECDH) com a pública de quem recebe e deriva a chave do
    envio (HKDF). A pública sorteada vai no cabeçalho `x-sd-eph`; daí em diante é a mesma cifra de sempre.
  - Com a opção desligada, pedido com `x-sd-eph` recebe 403. Uma oferta só continua com a mesma `x-sd-eph` que a
    abriu.
  - Nada é gravado antes do aceite: os `PUT` de uma oferta pendente ou recusada recebem 403.
- **Na rede:**
  - Tudo vai cifrado com AES-256-GCM (`src/lan/cripto.js`): pedidos, respostas, nomes de arquivo e conteúdo.
  - Cada pedido de dados sorteia uma sessão com chave própria (HKDF).
  - Cada bloco de até 4 MB carrega o arquivo e a posição no AAD.
  - Quem não tem a chave recebe 403 sem o corpo ser lido. Pedido com a hora fora de ±10 min é recusado.
- **Conferência:**
  - Quem manda calcula o xxHash64 lendo o arquivo uma vez.
  - Quem recebe calcula de novo sobre o que gravou e compara no fim.
  - Só então o arquivo é sincronizado com o disco (`fsync`) e ganha o nome final. Até lá ele fica em
    `.sobedesce-recebendo/`, que some sozinha.
  - Se não bater, o parcial é apagado e o arquivo vai de novo.
- **Caminhos:** `..`, raiz, nomes reservados do Windows e caracteres inválidos são recusados ou trocados. Nada escapa
  da pasta de recebidos.
- **Espaço:** quem recebe confere o espaço livre antes de aceitar.

## Velocidade e retomada

- **Vários arquivos ao mesmo tempo:** até 8 pequenos; os grandes vão um por vez.
- **Pedaços:** cada arquivo vai em pedaços de até 1 GB. Se a conexão cair (Wi-Fi piscou, o outro reiniciou a
  recepção), quem manda pergunta onde parou e segue dali, até 6 tentativas por arquivo.
- **Leitura adiantada:** o próximo bloco vem do disco enquanto o atual vai pela rede.
- **Medido no ambiente de teste** (Linux virtual, 1,5 GB em memória, dois processos em 127.0.0.1): ~320 MB/s com
  cifra e xxHash64 nos dois lados.
  - Isso passa de cabo de 1 Gbps (~115 MB/s) e de Wi-Fi.
  - Em rede de 10 Gbps, a cifra (num núcleo) vira o limite.
  - Num Mac com Apple Silicon o AES-GCM é bem mais rápido que nesta máquina de teste.

## Como funciona

```
site (web/src/lib/lan/presenca.ts)      tabela lan_presenca: endereços, porta, chave selada, chave pública, aceita outros, rede (HMAC), atualizado_em (3 min = online)
src/server/lan.js                       chave, liga/desliga o receptor (ajuste lanReceber), presença a cada 60 s, rotas, SSE 'lan'
src/lan/receptor.js                     servidor na rede (porta lanPorta, 4320; ocupada → outra): oferta, PUT de dados, fim
src/lan/enviador.js                     lista do site → ping cifrado em todos os endereços (vale o primeiro) → oferta → arquivos
src/lan/cripto.js                       selar/abrir (controle), meta (hora), blocos cifrados (dados)
```

### Rotas do receptor (rede local, tudo cifrado)

| Rota | O que faz |
| --- | --- |
| `POST /lan/v1/ping` | prova a chave; devolve nome e plataforma |
| `POST /lan/v1/ofertas` | `{ id, de, pessoa?, pasta, arquivos[] }` → posição de cada arquivo (`novo`, `igual`, `offset`); outra conta: `{ aguardando }` até aceitar, depois a posição, ou `{ recusada }` |
| `PUT /lan/v1/ofertas/:id/:n` | pedaço do arquivo `n` (meta: `sessao`, `offset`) → `{ offset }` |
| `POST /lan/v1/ofertas/:id/:n/fim` | `{ hash }` → confere, sincroniza, dá o nome final |
| `POST /lan/v1/ofertas/:id/fim` | encerra (aviso na tela de quem recebe) |

### Rotas do app (interface)

| Rota | O que faz |
| --- | --- |
| `GET /api/lan` | recepção (ligada, outros, porta, pasta, pedidos, chegando) e o envio atual; também no SSE `lan` |
| `GET /api/lan/computadores` | `{ computadores, porPerto }`: os da conta e os de outras contas por perto (sem chaves) |
| `POST /api/lan/responder` | `{ id, aceitar, drive?: { accountId, folderId, folderName? } }`: resposta a um pedido de outra conta (SSE `lan-pedido` avisa) |
| `POST /api/lan/enviar` | `{ para, origens[], pasta?, drive?: { accountId, folderId, folderName? } }` |
| `POST /api/lan/cancelar` / `POST /api/lan/limpar` | para o envio / tira o envio terminado da tela |

## Próximos passos

- Computadores em redes diferentes: o arquivo sobe pro Drive e o outro computador baixa sozinho (pedido pelo site).
- Cifra em vários núcleos (worker) para chegar perto de 1 GB/s em rede de 10 Gbps.
