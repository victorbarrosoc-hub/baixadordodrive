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
   - O espaço livre de cada destino. Se não couber, o botão de copiar não libera.
5. **Copiar**: anel de progresso, velocidade agora e média, tempo restante, tempo que passou e um gráfico da velocidade.
6. No fim, você vê o total, a média e a lista do que deu problema. O relatório `.md5` fica em cada destino.

## Segurança

- **Conferir (MD5):** depois de gravar, lê cada destino de novo e compara com o MD5 da origem.
  - Ligado por padrão.
  - Uma cópia que não bate é apagada e aparece na lista de problemas, para não parecer "igual" na próxima comparação.
- **Arquivo parcial:**
  - Grava em `<nome>.sobedesce-parcial`, sincroniza com o disco (`fsync`) e só então dá o nome final.
  - Se o cabo sair ou você parar, o parcial é apagado.
- **Data de modificação:** a de cada arquivo é mantida.
- **Disco cheio:** se um destino enche no meio, a cópia para e avisa.
- **Pastas de sistema:** `.Spotlight-V100`, `.fseventsd`, `.Trashes`, `System Volume Information` e `$RECYCLE.BIN`
  ficam de fora. Os arquivos `._` e `.DS_Store` também.
- **Destino × origem:** o destino não pode ficar dentro da origem, nem a origem dentro do destino.
- **Computador acordado:** ele não dorme durante a cópia (o mesmo ajudante das transferências).
- **Relatório:** `SOBEDESCE_copia_<data>.md5` usa o formato do `md5sum`. Dá para conferir depois:
  - `md5sum -c` (Linux) ou `md5 -r` (Mac);
  - ou comparando com o MD5 do Drive, que é o mesmo.

## Como funciona (`src/discos/`)

```
planejar.js   lê a origem (scanLocal) e faz um stat de cada arquivo em cada destino → novo | igual | diferente; statfs = espaço
servico.js    um trabalho por vez; fila de arquivos; velocidade (janela de 3 s) e média; tempo restante; relatório; SSE 'discos'
worker.js     roda a cópia fora da linha principal (o MD5 não trava o app); avisa os bytes 10× por segundo
copiar.js     blocos de 8 MB; lê o próximo bloco enquanto grava o atual em todos os destinos; MD5 no caminho; parcial → fsync
              → nome final → data; conferência lendo os destinos ao mesmo tempo
```

O tempo restante soma o que falta copiar e o que falta conferir. Ele é calculado pela média entre a velocidade dos
últimos 3 s e a média geral.

Medido no ambiente de teste (disco virtual): 329 MB para 2 destinos com conferência em 4 s.

## Rotas (`src/server/discos.js`)

| Rota | O que faz |
| --- | --- |
| `GET /api/discos` | estado (plano, andamento, resultado); também no SSE `discos` |
| `POST /api/discos/planejar` | `{ origem, destinos[], nome? }` → plano |
| `GET /api/discos/itens?estado&destino&de` | arquivos do plano (300 por vez) |
| `POST /api/discos/iniciar` | `{ substituir?, conferir?, relatorio? }` |
| `POST /api/discos/cancelar` | para (apaga o parcial do arquivo atual) |
| `POST /api/discos/limpar` | volta ao começo |
