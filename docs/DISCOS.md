# Copiar entre discos

Em **Comparar → Entre discos**, o app do computador passa um cartão de câmera, um SSD ou uma pasta para um ou mais
discos. Ele compara antes, copia só o que falta, confere cada arquivo e mostra a velocidade e o tempo restante.

## Como usar

1. Escolha a **origem**: o cartão, o SSD ou a pasta.
2. Escolha o **destino**. **Outro destino (backup)** adiciona mais um (até 4). A origem é lida uma vez só e gravada em
   todos ao mesmo tempo.
3. **Pasta no destino:** o nome da pasta criada dentro de cada destino. Por padrão é o nome da origem; dá para escrever
   o do projeto ("Casamento Ana e Leo").
4. **Comparar**: para cada destino, mostra:
   - **Novos:** não existem no destino.
   - **Já estão lá:** mesmo caminho e mesmo tamanho. Não são copiados de novo.
   - **Diferentes:** existem no destino com outro tamanho. Só são substituídos se você marcar
     **Substituir os diferentes**.
   - **Em outra pasta:** não estão no caminho esperado, mas já existem nessa mídia em outra pasta (o app procura no
     destino inteiro pelo nome e pelo tamanho). Não são copiados de novo, e a lista mostra onde cada um está. Arquivo
     pequeno (até 1 MB) só conta com a mesma data, porque índices de câmera como STATUS.BIN têm tamanho fixo. Com
     **Conferir também os que já estão no destino**, o conteúdo de cada um é comparado e o que não bater é copiado.
   - **Junto dos vizinhos:** um arquivo novo cuja pasta na origem tem outros arquivos achados em outra pasta do
     destino vai para essa pasta, e não para a pasta da cópia (o C055 vai para onde já estão o C054 e o C056). Vale
     também para subpastas (com o resto do caminho). Se a pasta tiver vizinhos em mais de um lugar, vai para onde estão
     mais deles. Se já existir um arquivo com o mesmo nome lá, fica na pasta da cópia. Dá para desligar em **Pôr os novos
     junto dos que já estão lá**.
   - O espaço livre de cada destino. Se não couber, o botão de copiar não libera.
5. **Copiar**: anel de progresso, velocidade agora e média, tempo restante, tempo que passou e um gráfico da velocidade.
6. No fim, você vê a cobertura de cada destino ("todos os N arquivos da origem estão aqui"), o total, a média e a lista
   do que deu problema. O relatório de checksums fica em cada destino.

## Velocidade

O objetivo é copiar mais rápido que o Finder, com a garantia que o Finder não dá.

- **Checksum xxHash64:**
  - É o padrão das ferramentas de offload de cinema e roda a ~4 GB/s.
  - O MD5 roda a ~0,6 GB/s e seria o gargalo num SSD rápido. Ele continua como opção, porque é o mesmo do Google Drive.
- **Arquivo grande:**
  - Quatro blocos de 8 MB em fila: três leituras adiantadas enquanto um bloco grava.
  - O checksum roda enquanto o disco grava.
  - Um arquivo grande por vez, em leitura sequencial (o que cartões e HDs preferem).
  - No teste em memória, o motor passou de ~0,75 GB/s para ~2,6 GB/s (o limite de gravação da máquina de teste).
- **Muitos arquivos pequenos:** até 24 ao mesmo tempo (fotos, RAW, áudio). O Finder copia um por vez.
- **Vários destinos:** a origem é lida uma vez e gravada em todos ao mesmo tempo. O Finder lê a origem de novo para cada
  destino.
- **Medido no ambiente de teste** (Linux, disco virtual), mediana de 3 rodadas:

| | `cp` (sem conferir) | SOBEDESCE sem conferir | SOBEDESCE conferido |
| --- | --- | --- | --- |
| 1.500 fotos (586 MB) | 1,31 s | 1,86 s | 1,90 s |
| 1 arquivo de 1,5 GB | 2,08 s | 1,97 s | 2,59 s |

  - O `cp` do Linux copia dentro do sistema (`copy_file_range`), sem passar pelo programa e sem conferir nada.
  - A comparação com o Finder tem que ser feita no Mac, com o cartão e o SSD de verdade.

## Segurança

- **Conferir:** depois de gravar, lê cada destino de novo e compara o checksum com o da origem.
  - Ligado por padrão.
  - Uma cópia que não bate é apagada e aparece na lista de problemas, para não parecer "igual" na próxima comparação.
  - O sistema pode entregar a leitura de volta da memória (o que acabou de ser gravado).
  - A conferência garante que o arquivo no destino é idêntico ao da origem: nada truncado, trocado ou corrompido no
    caminho.
  - O `fsync` antes do nome final garante que os dados foram para o disco.
- **Conferir também os que já estão no destino:** os "iguais" (mesmo nome e tamanho) têm o conteúdo comparado.
  - O que não bate é copiado de novo.
  - Pega a cópia antiga que ficou com o tamanho certo e o conteúdo errado.
- **Cobertura no fim:** para cada destino, diz quantos arquivos da origem estão lá e quantos foram conferidos pelo
  conteúdo. Mostra "todos os N arquivos da origem estão aqui", ou quantos faltam e por quê.
- **Erros de disco explicados:**
  - FAT32 com arquivo acima de 4 GB;
  - nome de arquivo que o destino não aceita;
  - disco que parou de responder;
  - disco cheio;
  - sem permissão.
- **Arquivo parcial:**
  - Grava em `<nome>.sobedesce-parcial`, sincroniza com o disco (`fsync`) e só então dá o nome final.
  - Se o cabo sair ou você parar, o parcial é apagado.
- **Data de modificação:** a de cada arquivo é mantida.
- **Disco cheio:** se um destino enche no meio, a cópia para e avisa.
- **Pastas de sistema:** `.Spotlight-V100`, `.fseventsd`, `.Trashes`, `System Volume Information` e `$RECYCLE.BIN`
  ficam de fora. Os arquivos `._` e `.DS_Store` também.
- **Destino × origem:** o destino não pode ficar dentro da origem, nem a origem dentro do destino.
- **Computador acordado:** ele não dorme durante a cópia (o mesmo ajudante das transferências).
- **Relatório:** `SOBEDESCE_copia_<data>.xxh64` (ou `.md5`), em ordem de caminho.
  - O formato é o do `xxhsum` / `md5sum`, então dá para conferir depois com `xxhsum -c` / `md5sum -c`.
  - No MD5, também dá para comparar com o checksum do Drive.

## Como funciona (`src/discos/`)

```
planejar.js   lê a origem (scanLocal) e faz um stat de cada arquivo em cada destino → novo | igual | diferente; statfs = espaço
servico.js    um trabalho por vez; fila de arquivos; velocidade (janela de 3 s) e média; tempo restante; relatório; SSE 'discos'
worker.js     roda a cópia fora da linha principal (o checksum não trava o app); vários arquivos ao mesmo tempo; avisa os
              bytes 10× por segundo e devolve os bytes contados de cada arquivo (o progresso fecha exato)
copiar.js     anel de 4 blocos de 8 MB (buffer do tamanho do arquivo quando é pequeno); xxHash64 (xxhash-wasm) ou MD5 no
              caminho; parcial → fsync → nome final → data; conferência lendo os destinos ao mesmo tempo;
              compararArquivos para os que já estavam lá
```

O tempo restante soma o que falta copiar e o que falta conferir. Ele é calculado pela média entre a velocidade dos
últimos 3 s e a média geral.


## Rotas (`src/server/discos.js`)

| Rota | O que faz |
| --- | --- |
| `GET /api/discos` | estado (plano, andamento, resultado); também no SSE `discos` |
| `POST /api/discos/planejar` | `{ origem, destinos[], nome? }` → plano |
| `GET /api/discos/itens?estado&destino&de` | arquivos do plano (300 por vez) |
| `POST /api/discos/iniciar` | `{ substituir?, conferir?, conferirIguais?, relatorio?, algoritmo?: 'xxh64'\|'md5' }` |
| `POST /api/discos/cancelar` | para (apaga o parcial do arquivo atual) |
| `POST /api/discos/limpar` | volta ao começo |
