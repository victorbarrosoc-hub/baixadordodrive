# Backup Automático (Cartões → Projetos)

Para o logger de set e para o backup rápido num evento: o projeto é configurado uma vez e, depois, é só espetar o
cartão. O app reconhece de quem é, copia só o que ainda não foi passado para a pasta certa, confere e diz se pode
formatar. Sem internet: nada vai para o Drive.

## Como usar

1. **Cartões → Backup Automático → Novo projeto:** o nome (vira a pasta principal), os destinos (o HD principal e até
   3 backups; o cartão é lido uma vez e gravado em todos) e, se quiser, "Ejetar o cartão ao terminar".
2. **Ligar o backup automático.**
3. **Espete o cartão.** Na primeira vez, um toque diz de quem ele é: um dono que já existe ou um novo, com nome e
   câmera ("Aladim" + "FX30"). A câmera vem preenchida quando o app consegue ler (Sony). "Ignorar este disco" serve
   para pendrive, HD de outra coisa etc.
4. **Pronto.** Nas próximas vezes, o mesmo cartão passa sozinho. Na tela: o andamento (velocidade, arquivos, tempo que
   falta), a fila (um cartão por vez), os cartões espetados com o estado de cada um, os donos da diária e o histórico.
5. **No fim de cada cartão:** "Cartão OK, pode formatar" (todos os arquivos do cartão estão em todos os destinos,
   conferidos) ou a lista do que falta. Também aparece um aviso do sistema.
6. **Nova diária:** botão na diária. Se a data mudou desde a última descarga, a tela sugere começar a próxima (não
   muda sozinha: evento que passa da meia-noite continua na mesma diária).

## Pastas

```
<destino>/<Projeto>/Diária 01/Cenas/Aladim - FX30/Cartão 01/<pastas do cartão, como estão>
```

- **"Cartão NN"** é por cartão físico, dentro do dono e da diária. Protege contra nomes iguais: um cartão formatado
  que recomeça em C0001, ou os arquivos de índice da câmera (MEDIAPRO.XML), não vão por cima de nada.
- **Segunda leva do mesmo cartão (sem formatar):** mesma pasta; copia só o que é novo.
- **Cartão formatado da mesma câmera** (Sony): o número de série do corpo, no XML ao lado de cada clipe, diz o dono;
  vira o próximo "Cartão NN".
- **Diária nova:** a numeração dos cartões recomeça (Diária 02 / … / Cartão 01).

## Como funciona

- **Vigia dos discos** (`src/backup/volumes.js`), a cada 3 s, só com o backup ligado:
  - macOS: `/Volumes`, sem a raiz (atalho), ocultos, disco interno e imagem de disco. Id = VolumeUUID do
    `diskutil info -plist`.
  - Windows: letras D: a Z:, sem CD/DVD e unidade de rede (PowerShell `Get-Volume`). Id = número de série do `vol`
    ("XXXX-XXXX"; o texto em português também funciona).
  - Linux: `/media/$USER` e `/run/media/$USER`. Id = UUID do `findmnt`.
  - Sem id do sistema: rótulo + capacidade.
  - Disco que contém um destino é ignorado (é o HD do backup, não um cartão).
- **De quem é** (`src/backup/servico.js`): 1) id do volume já visto no projeto; 2) serial da câmera no XML da Sony
  (`PRIVATE/M4ROOT/CLIP/*.XML` ou `XDROOT/Clip`, `<Device modelName serialNo>`; `src/backup/camera.js`); 3) senão, o
  pedido de um toque (SSE `backup-pedido` + aviso do sistema). O modelo da câmera pré-seleciona o dono quando só um
  dono tem aquela câmera ("mesma câmera"). Das outras marcas, só o tipo pela estrutura (GoPro, DJI, Canon,
  Panasonic, Blackmagic) para sugerir o nome.
- **A cópia** é o motor do "Entre discos" (`src/discos/`), numa instância própria (não mexe na tela Comparar):
  - compara por caminho e tamanho; copia só o que é novo; confere o copiado lendo de volta (xxHash64); grava o
    relatório `SOBEDESCE_copia_<data>.xxh64` na pasta do cartão em cada destino;
  - cada arquivo é gravado como `<nome>.sobedesce-parcial` e só ganha o nome final depois de completo e sincronizado:
    o Premiere/DaVinci, puxando da pasta em tempo real, nunca pega um clipe pela metade;
  - **comparativo automático:** depois de copiar, compara tudo de novo; se sobrou algo (falha), tenta mais uma vez;
  - **mesmo nome, outro tamanho no destino:** nunca grava por cima. Exceção: arquivo pequeno (até 32 MB) e mais novo no
    cartão (o índice/XML que a câmera reescreve entre uma leva e outra): o antigo vai para
    `.sobedesce-anteriores/<data>/` dentro da pasta do cartão e o novo é copiado. O resto vira alerta e o cartão não
    fica "OK".
- **Fila:** um cartão por vez, na ordem em que entraram.
- **Destino desconectado:** a descarga espera ("Esperando Backup SSD") e começa sozinha quando ele volta.
- **Cartão retirado no meio:** a descarga para com "O cartão saiu antes de terminar. Espete de novo: continua de onde
  parou." O arquivo pela metade é apagado; ao espetar de novo, a comparação copia só o que falta.
- **Ejetar:** opção do projeto (só quando está tudo certo) e botão por cartão: `diskutil eject` no Mac,
  `Shell.Application` → Eject no Windows, `gio mount -e` no Linux.
- **Dados** em `<pasta de dados do app>/backup-automatico.json` (gravação atômica: temporário + rename): projetos,
  destinos, diárias, donos, mapa cartão → dono, serial → dono, ignorados, numeração dos cartões e o histórico (até 500
  descargas: data, diária, dono, cartão, pasta, arquivos, bytes, duração, resultado).

## Rotas locais (`src/server/backup.js`)

| Rota | O quê |
| --- | --- |
| `GET /api/backup` | o estado (também em `/api/state` → `backup` e no SSE `backup`) |
| `POST /api/backup/projetos` `{ nome, destinos[], ejetar }` | cria e abre o projeto |
| `POST /api/backup/projeto` `{ id, nome?, destinos?, ejetar? }` | edita |
| `POST /api/backup/abrir` / `apagar` `{ id }` | troca de projeto / tira da lista (os arquivos ficam) |
| `POST /api/backup/ligar` `{ ligado }` | liga/desliga o vigia |
| `POST /api/backup/diaria` `{}` ou `{ n }` | nova diária / volta para uma diária |
| `POST /api/backup/responder` `{ caminho, donoId \| nome+camera \| ignorar }` | o toque "de quem é" |
| `POST /api/backup/repetir` / `ejetar` `{ caminho }` | copiar de novo / ejetar |
| `POST /api/backup/cancelar` | para a descarga de agora |
| `POST /api/backup/ignorados/limpar` | volta a perguntar pelos discos ignorados |

## Testar

`test/backup-automatico.test.js`: listagem e id dos discos por sistema (comandos falsos), o XML da Sony, o primeiro
toque e a cópia para os dois destinos, a segunda leva só com o novo (e o índice reescrito), o cartão formatado pelo
serial, o destino que espera, ignorar disco, o "mesmo nome, outro tamanho" que vira alerta e a persistência.

Falta testar com cartões e leitores de verdade (Mac e Windows): o VolumeUUID/serial de cartões formatados em câmera,
o `vol` no Windows em português e o ejetar.

## Espaço e quanto já passou

- **Cada destino** mostra o espaço livre, o tamanho do disco e uma barra do que já está ocupado. Com a média dos
  cartões da diária (ou do projeto, se a diária ainda não tem descarga), diz quantos cartões ainda cabem. Menos de 10%
  livre ou menos de 2 cartões: fica em laranja. O espaço é lido a cada varredura (3 s).
- **Já passou:** o total do projeto (GB, cartões e arquivos, somando todas as diárias) e o da diária atual. O total do
  projeto fica guardado no `backup-automatico.json` (projetos antigos somam pelo histórico).
