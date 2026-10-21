# SOBEDESCE · Aba Cartões

**Painel completo de cartões e mídias, com logger de set**
De: Victor Barroso · 20/out/2026

Tudo o que acontece com cartão de memória e disco num trabalho, num lugar só:
o que tem no cartão, de qual câmera veio, se já foi copiado, o que falta, quanto
tempo leva, a velocidade em tempo real, o contador de cliques da câmera, o teste
do cartão, a conta de quanta mídia levar e o resgate do que se perdeu.

> **Antes de começar:** o que este documento diz que o SOBEDESCE "já tem" (fila
> retomável, MD5, tela Comparar, ffmpeg embutido, proxy, aviso no celular) vem
> de uma leitura do README e dos docs do repositório. Confira no código antes
> de planejar em cima.

## Andamento (atualizado a cada entrega)

| # | Parte | Estado |
|---|---|---|
| 1 | Calculadora | **feita**: aba Cartões no app do computador e página grátis `sobedesce.com/calculadora`. Conta em `web/src/lib/midia/conta.js` (cópia igual em `public/lib/midia-conta.js`), 47 modos prontos de 20 câmeras, cada um com o link do fabricante, em `modos.js`, testes em `test/midia-conta.test.js` |
| 7 | Resgate: o motor | **feito** (sem tela ainda): consertar clipe sem índice e varredura por assinatura, código próprio sem GPL. Ver `docs/RESGATE.md` |
| 2 (parte) | Logger de set: **Backup Automático** | **feito**: Cartões → Backup Automático. Projeto com destinos e diária; espetou o cartão, um toque diz o dono na primeira vez; depois copia sozinho só o novo para `Diária NN/Cenas/Dono - Câmera/Cartão NN`, confere (xxHash64), compara de novo e diz "Cartão OK, pode formatar". Ver `docs/BACKUP-AUTOMATICO.md` |
| 2–6, 8 | Resto do painel e do logger, velocidade, câmeras, teste de cartão; a tela do Resgate | a fazer |

### Conferido no código (o que o documento diz que "já tem")

- **Fila retomável, MD5, tela Comparar, ffmpeg embutido, proxy, aviso no celular:** existem.
- **O motor de cópia só fala com o Drive.** As transferências são envio e download (`src/engine/upload.js`,
  `download.js`); **não existe cópia de disco para disco** (cartão → HD 1 e HD 2). O logger (§2) precisa de um tipo
  novo de transferência: leitura única da origem, escrita em vários destinos e conferência lendo de volta. A fila,
  a retomada e o MD5 em worker são reaproveitáveis.
- **"Comparar" compara pasta do computador × pasta do Drive.** Comparar com HD, SSD ou outro cartão (§2) é novo.
- **"128 GB aparece com 119 GB no computador" vale para o Windows.** O Mac conta como o fabricante (1 GB =
  1.000.000.000 bytes) e mostra perto de 128. A calculadora mostra os dois.

---

## Sumário

0. [Regras que valem para a aba inteira](#0-regras-que-valem-para-a-aba-inteira)
1. [Painel de cartões e mídias](#1-painel-de-cartões-e-mídias)
2. [Logger de set](#2-logger-de-set)
3. [Velocidade em tempo real](#3-velocidade-em-tempo-real)
4. [Câmeras e contador de cliques](#4-câmeras-e-contador-de-cliques)
5. [Teste de cartão](#5-teste-de-cartão)
6. [Calculadora de mídia](#6-calculadora-de-mídia)
7. [Resgate](#7-resgate)
8. [Notas técnicas](#8-notas-técnicas)
9. [Ordem de construção](#9-ordem-de-construção)

---

## 0. Regras que valem para a aba inteira

1. **O app nunca escreve no cartão de origem e nunca formata.** Nem arquivo de
   controle, nem etiqueta escondida. Ele só diz *"pode formatar"*.
2. **Conferir é ler de volta do destino.** O hash do arquivo na origem contra o
   hash lido do disco de destino, nunca da memória do computador.
3. **Nada é inventado.** Bitrate, vida útil de obturador, contagem de cliques,
   saúde de cartão: se o arquivo ou o aparelho não informa, a tela diz *"não
   informado"*. Estimativa só aparece com a conta aberta e com o nome
   *estimativa*.
4. **Funciona sem internet e sem conectar o Google.** A aba Cartões não depende
   do Drive. O Drive é um destino a mais, opcional. Assim ela também não esbarra
   no limite de usuários do app do Google enquanto ele não é verificado.
5. **Nada sai do computador** sem a pessoa escolher o Drive como destino.
6. **Mesmo nome não é mesmo arquivo.** Dois cartões formatados em câmeras iguais
   geram os mesmos nomes (`A001_C001`). Arquivo igual é nome + tamanho + hash.
   Qualquer outra combinação é outro arquivo: entra como novo, nunca é
   descartado, e o app avisa.
7. **Cópia parcial nunca fica verde.** 47 de 48 é *"falta 1"*, com o nome do
   arquivo.

---

## 1. Painel de cartões e mídias

A tela que abre a aba. Responde em um olhar: *o que está plugado, o que tem
dentro, e o que já está seguro.*

### O que mostra de cada cartão ou disco plugado

| Campo | De onde vem |
|---|---|
| Nome do volume, tipo (SD, CFexpress, SSD, HD) | sistema operacional |
| Capacidade real, usado, livre | sistema (em GB de verdade, ver 8.4) |
| Sistema de arquivos (exFAT, FAT32, APFS, NTFS) | sistema; FAT32 ganha aviso do limite de 4 GB por arquivo |
| Câmera detectada (marca, modelo, número de série) | metadados dos arquivos (ver seção 4) |
| Rolo (`A001`, `B003`…) | nome dos arquivos ou da pasta |
| Quantidade de clipes e fotos, duração total | leitura dos arquivos |
| Primeiro e último horário gravado | metadados (com aviso se o relógio da câmera parece errado) |
| Formatos: codec, resolução, quadros por segundo, bitrate | metadados, via ffprobe |
| **Situação** | ver abaixo |

### A situação do cartão, em uma palavra

| Situação | Quando |
|---|---|
| **Novo** | nada dele foi copiado ainda |
| **Copiando** | cópia em andamento |
| **1 de 2** | uma cópia conferida, falta a outra |
| **Conferido** | todas as cópias pedidas conferidas |
| **Pode formatar** | conferido, sem nenhum alerta pendente |
| **Atenção** | alerta pendente (ver lista abaixo) |

### Mídias: a visão de dentro

- **Por câmera, por rolo e por dia:** quantos clipes, quantas horas, quantos GB.
- **Miniatura e prévia** de cada clipe e foto (o proxy e a prévia de BRAW e PSD
  que o SOBEDESCE já faz servem aqui).
- **Filtro:** câmera, rolo, formato, dia, situação (copiado, falta, diferente).

### Alertas automáticos

- clipe com **0 bytes** ou **truncado** (o vídeo que perdeu o índice porque a
  bateria acabou no meio da gravação), com o botão **Consertar** que leva ao
  Resgate (seção 7);
- **relógio da câmera errado** (data de fábrica, como 01/01/2000, ou futura);
- cartão **quase cheio**;
- **FAT32** com arquivo perto de 4 GB;
- **destino sem espaço** para o que vai ser copiado (avisa ANTES de começar);
- **disco de destino sumiu** no meio da cópia (pausa e retoma sozinho quando
  volta).

---

## 2. Logger de set

O coração da aba. Feito para a mesa do set, onde chegam vários cartões, de
várias câmeras, várias vezes no mesmo dia, e ninguém tem tempo de preencher
formulário.

### O gesto é plugar

1. Pluga o cartão. O app reconhece câmera, rolo, arquivos e tamanho, sem
   pedir nada.
2. Os destinos ficam escolhidos para o dia inteiro (HD 1, HD 2 e, se quiser, o
   Drive). Não se escolhe de novo a cada cartão.
3. Um botão: **Copiar**. Copia para os destinos ao mesmo tempo, lendo o cartão
   uma vez só, e confere cada arquivo lendo de volta de cada destino.
4. Quando tudo confere: **"Pode formatar o cartão A003"**, com a hora, e aviso
   no celular.

### A unidade é a chegada, não o cartão

O mesmo cartão volta várias vezes no dia com takes novos. Cada vez que ele é
plugado vira uma **chegada**, com os arquivos daquela vez. O app copia **só o
que é novo**, sem duplicar o que já foi copiado na chegada anterior.

### O comparador: "isto já foi passado?"

Compara qualquer cartão com qualquer destino: HD, SSD, outro cartão ou pasta do
Drive. Dois modos:

| Modo | Compara | Para quê |
|---|---|---|
| **Rápido** | nome + tamanho + data | resposta em segundos, para conferir na correria |
| **Completo** | hash de cada arquivo | prova de que a cópia está íntegra |

Resultado, arquivo por arquivo:

| Estado | Significa |
|---|---|
| **Copiado e conferido** | está no destino, com hash igual |
| **Copiado, sem conferir** | está lá, ainda não foi conferido por hash |
| **Falta** | não está no destino |
| **Diferente** | mesmo nome, tamanho ou hash diferente: outro arquivo ou cópia corrompida |
| **Só no destino** | está no destino e não no cartão (informativo, nunca apaga) |

E o resumo em uma linha: **"Faltam 23 arquivos, 186 GB, cerca de 12 minutos
neste leitor"**, com o botão **Copiar o que falta**.

### Quanto tempo vai demorar

- **Antes de começar:** estima pelo tamanho a copiar e pela velocidade que
  aquele leitor e aquele disco fizeram da última vez (*"na última cópia este
  leitor e o HD 2 fizeram 280 MB/s"*). Sem histórico, mede nos primeiros
  segundos e só então mostra.
- **Durante:** tempo restante e **hora prevista de término no relógio**
  (*"termina por volta de 14h37"*), recalculados pela média dos últimos 30
  segundos, para o número não pular a cada instante.
- O tempo da conferência entra na conta. Copiar sem conferir não termina o
  trabalho.

### Vários cartões ao mesmo tempo

- **Fila:** cartões plugados em leitores diferentes copiam em paralelo; no
  mesmo leitor, entram em fila.
- A ordem da fila pode ser mudada (o cartão que precisa voltar logo para a
  câmera passa na frente).
- Tudo retoma depois de fechar o app, dormir o computador ou desconectar um
  disco.

### O quadro do dia

Uma visão por diária, para quem coordena a mesa:

| Rolo | Câmera | Chegadas | Clipes | Duração | GB | HD 1 | HD 2 | Drive | Situação |
|---|---|---|---|---|---|---|---|---|---|
| A001 | FX3 · série …4821 | 3 | 142 | 2h18 | 512 | ✓ | ✓ | ✓ | Pode formatar |
| B001 | A7 IV · série …1177 | 1 | 38 | 0h41 | 96 | ✓ | copiando 62% | — | 1 de 2 |

- **Observação por rolo** (opcional, digitada se a pessoa quiser): *"áudio
  externo no B"*, *"cartão com mau contato"*.
- **Operador** de cada cópia (a conta logada).

### O relatório do dia

- **PDF** para a produção e para o cliente: rolos, câmeras, horários, tamanhos,
  destinos, conferência.
- **Arquivo de hashes no padrão ASC MHL**, que os softwares de DIT e de pós
  leem.
- **CSV** com uma linha por clipe: rolo, câmera, número de série, nome,
  duração, timecode inicial (quando o arquivo traz), tamanho, hash, destinos.

### Regras do logger

- **"Pode formatar" só aparece quando todas as cópias pedidas conferiram E não
  há alerta pendente** (clipe truncado, por exemplo, segura o cartão até alguém
  olhar).
- **Conflito nunca sobrescreve:** vira pasta nova no destino.
- **Nome de pasta padrão editável:** `AAAA-MM-DD_Projeto_Câmera_Rolo`.
- **Rolo adivinhado por dois caminhos:** pelo nome do arquivo (`A001_C047.braw`,
  `A012_C001_0812XY.R3D`) e pelo nome da pasta. Cartão formatado às vezes monta
  como "NO NAME", e aí só o arquivo salva; algumas câmeras gravam `C0001.MP4`
  sem rolo, e aí só a pasta salva. Um caminho não cobre o outro.

### Pronto quando

- dois HDs recebem a cópia, o HD 2 é desconectado no meio, volta, a cópia
  retoma e o relatório sai com tudo conferido;
- um arquivo alterado de propósito no destino aparece como **Diferente**;
- dois cartões com os mesmos nomes de arquivo e conteúdo diferente entram os
  dois, com aviso;
- o mesmo cartão plugado de novo com 10 takes novos copia só os 10;
- **"Pode formatar" nunca aparece** com cópia pendente ou alerta aberto.

---

## 3. Velocidade em tempo real

Mostra a velocidade de verdade e **diz quem é o gargalo**.

### Durante a cópia

| Mostra | Como |
|---|---|
| Leitura do cartão | MB/s agora, média, pico |
| Escrita em cada destino | MB/s agora, por disco |
| Envio ao Drive | MB/s, se o Drive for destino |
| Gráfico | últimos 60 segundos, uma linha por disco |
| Gargalo | *"o limite é o leitor de cartão"*, *"o HD 2 é o mais lento"*, *"a internet está segurando o Drive"* |
| Conexão | tipo de porta e velocidade do link USB/Thunderbolt, quando o sistema informa |

**Referências que a tela pode mostrar para explicar o gargalo** (valores reais
aproximados):

| Conexão | Na prática |
|---|---|
| USB 2.0 | ~35 a 40 MB/s |
| USB 3.2 Gen 1 (5 Gb/s) | ~400 MB/s |
| USB 3.2 Gen 2 (10 Gb/s) | ~900 a 1.000 MB/s |

Exemplo do aviso: *"Este leitor está conectado em USB 2.0: a cópia vai levar
cerca de 10 vezes mais. Troque a porta ou o cabo."*

### A velocidade de gravação

O app não vê a câmera gravando, mas sabe as duas pontas da conta:

- **O que a câmera pediu:** o bitrate dos clipes que estão no cartão (ex.: 600
  Mb/s = 75 MB/s).
- **O que o cartão aguenta:** a escrita sustentada medida no teste (seção 5) e
  a classe que ele declara (V30, V60, V90, VPG).
- O veredito: *"Este cartão gravou 4K a 600 Mb/s com folga"* ou *"No limite:
  o modo pede 75 MB/s e o cartão sustentou 79 MB/s no último teste"*.

### Histórico de velocidade

Cada leitor e cada disco guardam a velocidade média das últimas cópias. É isso
que alimenta a previsão de tempo do logger e mostra quando um HD começou a
ficar lento.

---

## 4. Câmeras e contador de cliques

Identifica a câmera **pelo arquivo** e mostra o contador de cliques quando o
arquivo traz essa informação.

### Identificar a câmera

Por três caminhos, nesta ordem de confiança:

1. **Metadados do arquivo:** marca, modelo e número de série (EXIF nas fotos;
   metadados do vídeo; o XML que algumas câmeras gravam ao lado do clipe; o SDK
   da Blackmagic no caso do BRAW).
2. **Estrutura de pastas** do cartão, que denuncia a marca mesmo sem metadado:
   `PRIVATE/M4ROOT` (vídeo Sony), `DCIM/100CANON`, `DCIM/100GOPRO`, nomes como
   `DJI_0001.MP4`.
3. **Nome do arquivo:** prefixos de rolo e de câmera.

Com o número de série, cada câmera ganha uma **ficha própria** que acumula ao
longo do tempo: cartões que passaram por ela, horas gravadas, fotos tiradas,
formatos usados.

### O contador de cliques

- Lido da **foto mais recente** do cartão.
- Guardado por número de série, para mostrar a evolução: **cliques por mês**,
  **cliques neste trabalho**, **total**.
- Serve para manutenção, para planejar troca de obturador e para vender a
  câmera usada com um número de verdade.

**O que dá para prometer, com honestidade:**

| Fabricante | O contador vem no arquivo? |
|---|---|
| Nikon | geralmente sim, nos dados do fabricante dentro da foto |
| Sony | em muitos modelos, numa parte codificada que ferramentas de metadados conseguem ler |
| Pentax | geralmente sim |
| Fujifilm, Panasonic | em alguns modelos |
| Canon | na maioria dos modelos não; costuma exigir a câmera ligada por cabo USB |

**Esta tabela precisa ser confirmada modelo a modelo com arquivos reais antes
de virar promessa na tela.** Regras:

- **Modelo sem contador no arquivo: a tela diz "este modelo não grava o
  contador na foto"**, e não mostra número nenhum.
- **Obturador eletrônico:** algumas câmeras contam só o mecânico. A tela diz
  qual contador é, quando o fabricante deixa claro.
- **Vida útil do obturador só aparece se o fabricante publica** o número, com a
  fonte. Sem isso, mostra só a contagem.
- **Vídeo não tem clique:** para câmera de vídeo, a ficha mostra horas gravadas
  e clipes, a partir do histórico do próprio app.

### Pronto quando

- uma foto de Nikon e uma de Sony de modelos testados mostram o mesmo contador
  que uma ferramenta de referência de metadados mostra;
- uma foto de modelo sem contador mostra a frase de "não grava", sem número;
- a mesma câmera em dois cartões diferentes cai na mesma ficha pelo número de
  série.

---

## 5. Teste de cartão

**A bronca:** cartão falso (diz 256 GB, guarda 32 GB e corrompe o resto),
cartão lento que para de gravar no meio do take, cartão com defeito. Quase
ninguém testa o cartão novo antes do trabalho.

### O que mede

- **Capacidade real:** escreve dados conhecidos, lê de volta e confere. Cartão
  falso aparece na hora.
- **Escrita sustentada:** a **mínima** ao longo do teste, que é a que importa
  para gravar vídeo (o pico não serve).
- **Leitura:** a velocidade que vai valer na hora de copiar.
- **Erros:** setor que não guarda o que foi escrito.

E compara com a classe que o cartão declara:

| Classe | Escrita mínima sustentada |
|---|---|
| V30 / U3 | 30 MB/s |
| V60 | 60 MB/s |
| V90 | 90 MB/s |
| CFexpress VPG200 / VPG400 | 200 / 400 MB/s |

### Dois modos

| Modo | O que faz | Apaga algo? |
|---|---|---|
| **Rápido** | testa só o espaço livre | não |
| **Completo** | testa o cartão inteiro | **sim:** exige cartão vazio |

### Veredito em uma linha, com a câmera da pessoa

*"Este cartão aguenta 4K 10-bit a 600 Mb/s? Sim, com folga."* ou *"Não: ele cai
para 41 MB/s e o modo pede 75 MB/s."* Usa os modos da calculadora (seção 6).

### Histórico por cartão

A pessoa dá um apelido ao cartão (*"SD azul 128"*). O app guarda os testes, e
cartão que ficou mais lento entre um teste e outro ganha o aviso de que está na
hora de aposentar.

⚠️ O cartão é reconhecido pelo apelido e pelos dados do volume. Formatar muda a
identificação do volume, e a maioria dos leitores USB não deixa ler o número de
série de fábrica do cartão. Por isso o app pergunta *"é o SD azul 128?"* quando
não tiver certeza, em vez de adivinhar.

### Regras

- O **modo completo trava se o cartão tem arquivo sem cópia conferida** no
  logger.
- **O teste não promete o futuro:** diz se o cartão é verdadeiro e rápido hoje,
  não que não vai falhar amanhã. A tela diz isso.
- **Mede pelo leitor que a pessoa usa** e avisa quando o leitor é mais lento que
  o cartão; senão todo cartão parece lento.

### Pronto quando

- um volume simulado menor que o declarado é detectado como falso;
- o modo rápido não toca em nenhum arquivo existente (conferido por hash antes e
  depois);
- o modo completo se recusa a rodar com arquivo não copiado.

---

## 6. Calculadora de mídia

**A bronca:** *"Quantos cartões e HDs eu levo para 10 horas de casamento em
4K?"* Hoje se faz de cabeça, e erra-se para menos.

### Entradas

- câmera e modo de gravação (formato, resolução, quadros por segundo, bitrate),
  podendo somar várias câmeras com modos diferentes;
- horas de gravação previstas (ou minutos por diária × diárias);
- cartões disponíveis (capacidade) e leitor e HD (velocidade).

### Saídas, com a conta aberta

- GB por hora de cada câmera e do trabalho inteiro;
- quanto cabe em cada cartão, em horas e minutos;
- quantos cartões levar, com margem;
- tamanho dos HDs de backup (vezes 2, porque são duas cópias);
- tempo estimado de cópia no fim da diária.

### A conta, para ficar no código e na tela

```
GB por hora = bitrate em Mb/s × 3600 ÷ 8 ÷ 1000
ex.: 100 Mb/s → 45 GB por hora
```

E o aviso que pega todo mundo: **o cartão de "128 GB" aparece com cerca de
119 GB no computador.** O fabricante conta 1 GB = 1.000.000.000 bytes, e o
sistema conta em 1.073.741.824. A calculadora usa a capacidade real.

### Regras

- **Nenhum bitrate inventado.** Cada modo pronto (Sony FX3, A7S III, A7 IV,
  Canon R6, BMPCC 6K em BRAW, drones DJI, iPhone em ProRes etc.) traz a fonte,
  o manual do fabricante. Modo sem fonte confirmada não entra pronto: a pessoa
  digita o bitrate.
- **Melhor ainda: aprender com os arquivos.** Quando a câmera já passou pelo
  app, o bitrate real dos clipes dela vira o modo pronto, com a etiqueta *"medido
  nos seus arquivos"*.
- A conta aparece inteira, linha por linha.

**Onde roda:** é só conta. Pode existir na aba Cartões e numa página web grátis,
que serve de vitrine para baixar o app.

---

## 7. Resgate

**A bronca:** o cartão foi formatado antes do backup, alguém apagou o take
errado, o computador diz que o cartão "precisa ser formatado", o vídeo não abre
porque a bateria acabou no meio da gravação. É a hora mais desesperada do set,
e hoje a saída é software estrangeiro pago em dólar ou laboratório.

Três funções na mesma tela:

| Função | Para quê |
|---|---|
| **Recuperar** | arquivos de cartão formatado, apagado ou com erro |
| **Consertar vídeo** | o clipe que não abre porque a gravação foi interrompida |
| **Abrir projeto** | o projeto do Premiere que não abre (versão mais nova ou arquivo danificado) |

### 7.1 Antes de tudo: o que aconteceu?

A tela começa com uma pergunta de um toque, porque a resposta muda o que dá
para fazer e o que a pessoa pode esperar:

| O que aconteceu | Chance | Por quê |
|---|---|---|
| Formatei na câmera e não gravei mais nada | **boa** | a formatação rápida apaga o índice, não os arquivos |
| Apaguei arquivos na câmera | **boa** | o espaço é marcado como livre, o conteúdo continua lá |
| O computador pede para formatar o cartão | **boa** | o sistema de arquivos estragou, os dados geralmente não |
| Gravei por cima depois de formatar | **parcial** | volta só o que não foi sobrescrito |
| Usei a formatação completa ("baixo nível") da câmera | **baixa** | ela escreve por cima do cartão inteiro |
| É SSD ou NVMe e eu apaguei ou formatei | **baixa** | o próprio SSD zera os blocos apagados pouco depois |
| O computador nem enxerga o cartão, ou ele quebrou ou molhou | **laboratório** | defeito físico: o app indica procurar um laboratório e não tenta |

⚠️ **A tela nunca mostra porcentagem de chance.** "Boa", "parcial" e "baixa"
vêm com o motivo escrito. Número de chance seria inventado.

E três avisos aparecem antes de qualquer botão:

- **Pare de usar o cartão.** Cada foto nova pode gravar em cima do que se quer
  recuperar.
- **Não formate**, mesmo que o computador peça.
- **Salve sempre em outro disco**, nunca no mesmo cartão.

### 7.2 Recuperar

**Primeiro, a imagem do cartão.** O app faz uma cópia bit a bit do cartão
inteiro para um disco e trabalha em cima dela, não do cartão. Se o cartão está
falhando, cada leitura a mais pode ser a última; com a imagem pronta, o cartão
pode ir para a gaveta.

- A imagem precisa de espaço igual ao tamanho do cartão (um cartão de 512 GB
  pede 512 GB livres). O app avisa antes.
- **Setor com erro não trava a imagem:** o app lê primeiro o que é fácil, pula
  as partes com erro e volta nelas no fim, com mais calma.
- Para cartão saudável (formatado sem querer, sem erro de leitura), a pessoa
  pode escolher varrer direto, sem imagem. Com erro de leitura, a imagem é
  obrigatória.

**Depois, duas passadas:**

1. **O que sobrou do sistema de arquivos.** Muitas vezes os nomes e as pastas
   originais ainda estão lá, só marcados como apagados. Quando estão, o arquivo
   volta com o nome, a pasta e a data de antes.
2. **Varredura por assinatura.** O app lê o cartão inteiro procurando o começo
   de cada tipo de arquivo (vídeo, foto, RAW). Acha arquivo mesmo sem nenhum
   índice, mas sem o nome original.

**Formatos da primeira leva:** MP4 e MOV (H.264, H.265, ProRes), JPG e os RAW
de foto (CR2, CR3, NEF, ARW, DNG). Formatos fechados como BRAW e R3D ficam para
uma segunda etapa, depois de testar com arquivos reais.

**A prévia antes de salvar.** A lista mostra miniatura de cada foto e um quadro
de cada vídeo encontrado, com tamanho, duração e data. O que a pessoa vê é o
que vai receber. Arquivo encontrado com defeito aparece como **"recuperado com
defeito"**, com o botão **Consertar**.

**Já está no backup?** Antes de salvar, o app passa os achados pelo comparador
do logger: *"38 destes 52 arquivos já estão no HD 1"*. Às vezes o desespero é
desnecessário, e isso economiza horas.

**Nome de quem volta sem nome:** tipo + data e hora dos metadados + câmera +
número, por exemplo `recuperado_2026-10-12_1432_FX3_0001.mp4`.

**Sugestão de cobrança:** buscar e ver a prévia de graça; salvar é do plano. É
o momento em que a pessoa mais entende o valor.

### 7.3 Consertar vídeo

O caso mais comum do set: a bateria acabou, o cartão saiu antes da hora ou a
câmera travou no meio do take. O arquivo existe, tem o tamanho certo, e não
abre. Falta o índice que a câmera escreveria no fim da gravação.

- O conserto **reconstrói o índice** usando um **clipe bom da mesma câmera, no
  mesmo modo** (resolução, quadros por segundo, codec).
- **O clipe de referência é sugerido sozinho:** pelo número de série e pelo
  modo, o app procura nos cartões e no histórico do logger um clipe bom daquela
  câmera. Sem nenhum, pede para a pessoa gravar 5 segundos no mesmo modo.
- **Gera um arquivo novo.** O original fica intocado.
- **Diz o que voltou:** *"recuperados 14min32s; os últimos segundos podem
  faltar"*.
- Começa por MP4 e MOV de câmeras comuns (Sony, Canon, Panasonic, DJI, GoPro,
  iPhone), testados modelo a modelo.

### 7.4 Abrir projeto

O arquivo de projeto do Premiere é texto compactado por dentro, e isso abre
dois consertos simples:

- **Projeto salvo numa versão mais nova** que a do computador da ilha: o app
  gera uma cópia que abre na versão anterior. A tela avisa que efeito que só
  existe na versão nova pode não vir junto.
- **Projeto danificado:** o app tenta abrir o que dá e, quando o arquivo está
  muito estragado, ao menos devolve a lista de mídias e de sequências.
- **Procura as cópias automáticas** que o Premiere guarda sozinho e mostra as
  mais recentes, com data e hora. Muita gente não sabe que elas existem.

Sempre numa cópia; o original nunca é alterado. Outros editores entram depois
de testar com projetos reais.

### 7.5 Regras do Resgate

- **Só leitura no cartão**, como na aba inteira. O Resgate nunca escreve nem
  formata o cartão que está tentando salvar.
- **Nada é prometido.** "Chance boa" não é garantia, e a tela diz isso.
- **Tudo acontece no computador.** O material de um cliente perdido não sobe
  para lugar nenhum para ser recuperado.

### 7.6 Pronto quando

- um cartão de teste com fotos e clipes conhecidos, formatado na câmera, devolve
  todos com o hash igual ao original;
- um clipe com o índice removido de propósito é consertado, abre no player e no
  editor, e a tela diz a duração recuperada;
- o hash do cartão é o mesmo antes e depois do Resgate (nada foi escrito nele);
- um SSD apagado recebe "chance baixa" com o motivo, antes de qualquer
  varredura;
- os achados que já estão no backup são apontados antes de salvar;
- um projeto de versão mais nova abre na versão anterior pela cópia, com o
  original intocado.

---

## 8. Notas técnicas

### 8.1 Leitura de metadados

- **ffprobe** (já embutido com o ffmpeg) para vídeo: codec, resolução, quadros
  por segundo, bitrate, duração, timecode.
- **Uma ferramenta de metadados de foto** para EXIF e dados do fabricante
  (modelo, número de série, contador). A referência do mercado é o exiftool:
  conferir a licença dele antes de embutir num produto pago.
- **XML ao lado do clipe** (algumas câmeras Sony e outras gravam): modelo e
  número de série do aparelho.
- **BRAW:** o SDK da Blackmagic que o SOBEDESCE já usa.

### 8.2 Hash

- Além do **MD5** que o SOBEDESCE já usa, oferecer **xxHash64**, bem mais rápido
  em cartão de 512 GB a 1 TB e aceito pelo ASC MHL.
- Calcular o hash da origem **durante a leitura** da cópia, não numa segunda
  passada: o cartão é lido uma vez só.

### 8.3 Permissões e sistema

- **Mac:** ler volume removível pede permissão do sistema; a primeira vez
  precisa explicar o pedido em uma frase.
- **Velocidade do link USB/Thunderbolt:** o Mac e o Windows informam o tipo de
  conexão de cada dispositivo pelas APIs do sistema; quando não informam, a tela
  mostra só a velocidade medida.
- **Ejetar com segurança:** depois do "pode formatar", oferecer ejetar o cartão
  pelo próprio app.

### 8.4 GB de verdade

A tela mostra capacidade e espaço como o sistema mostra, e sempre explica a
diferença para o número impresso no cartão quando a pessoa passar o mouse.

### 8.5 Acesso ao cartão "por baixo" (Resgate)

- Ler o cartão bit a bit pede permissão de administrador no Mac e no Windows.
  O caminho seguro é um **processo auxiliar com essa permissão só para ler**,
  separado do resto do app, que pede autorização uma vez por resgate.
- Existem motores de código aberto para recuperar e consertar vídeo, mas com
  licença GPL: num produto pago, isso pede cuidado jurídico (ou escrever o motor
  próprio para os formatos da primeira leva, o que é viável).
- A varredura por assinatura reconhece MP4/MOV e CR3 pela estrutura de caixas
  do formato, JPG pelos marcadores de início e fim, e os RAW de base TIFF (CR2,
  NEF, ARW, DNG) pelo cabeçalho.
- Cartão recém-formatado na câmera grava os arquivos em sequência, sem
  fragmentar, e é por isso que ele recupera tão bem. Cartão usado por muito
  tempo sem formatar fragmenta, e a varredura por assinatura perde força: a
  primeira passada (o que sobrou do sistema de arquivos) importa mais nele.

### 8.6 Celular

As operações de cartão são do computador. No celular: **acompanhar a fila**
(o que está copiando, quanto falta, hora prevista), **receber o aviso** de "pode
formatar" e **ver o quadro do dia**. O aviso por push já existe no SOBEDESCE.

### 8.7 Organização do código

Escrever a aba Cartões como um **módulo que não depende das telas do Drive**.
Assim, se um dia ela crescer e virar app próprio, nada precisa ser refeito.

---

## 9. Ordem de construção

| # | O quê | Por quê |
|---|---|---|
| 1 | **Calculadora** | só conta; sai rápido e já serve de vitrine na web |
| 2 | **Painel de cartões e mídias** | é a base que todas as outras partes leem |
| 3 | **Logger de set** com o comparador | a maior parte do motor de cópia já existe |
| 4 | **Velocidade em tempo real** | nasce junto com a cópia do logger |
| 5 | **Resgate: consertar vídeo e abrir projeto** | o painel já acusa o clipe truncado; o conserto fecha o alerta, e o motor de vídeo (ffmpeg) já está no app |
| 6 | **Câmeras e contador de cliques** | depende de testar modelo a modelo com arquivos reais |
| 7 | **Teste de cartão** | usa a calculadora para o veredito e o logger para a trava |
| 8 | **Resgate: recuperar cartão** | o mais difícil: acesso de administrador, imagem do cartão e varredura; vem por último porque o logger evita a maior parte dos casos |

**Antes de vender para fora do círculo de teste:** assinar os instaladores
(Apple Developer ID com notarização e certificado da Microsoft). Num app que
mexe no cartão do cliente, o aviso de "desenvolvedor não identificado" afasta
justamente quem mais precisa.
