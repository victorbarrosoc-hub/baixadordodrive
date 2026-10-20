# Resgate: o motor (código próprio, sem GPL)

A aba Cartões (docs/CARTOES.md §7) precisa recuperar arquivos de cartão formatado e consertar o clipe que perdeu o
índice. Os motores de código aberto que fazem isso (varredura e conserto de MP4) são GPL, e o SOBEDESCE é pago: o
motor é nosso, em `src/resgate/`, sem dependências. Ele só lê a origem e sempre grava arquivos novos.

## Consertar vídeo (`consertar.js`)

O clipe interrompido (bateria, cartão puxado, câmera travada) tem os dados mas não tem o `moov`, o índice que a
câmera grava no fim. O conserto usa um **clipe bom da mesma câmera, no mesmo modo** como referência:

1. Da referência sai o formato de cada faixa (codec, `avcC`/`hvcC`, PCM), o tamanho dos pedaços e a intercalação.
2. Os dados do clipe quebrado são lidos do começo ao fim e cada pedaço é reconhecido:
   - **vídeo H.264/H.265** pelo formato das NAL (tamanho + cabeçalho válido + começo de imagem), um quadro por vez
     (`nal.js`), com o cabeçalho da fatia conferido para não confundir dado qualquer com vídeo;
   - **ProRes** pelo tamanho + `icpf` de cada quadro;
   - **pedaços de tamanho fixo** (áudio PCM, timecode, metadados de câmera), aceitos quando o que vem depois também
     se reconhece;
   - trecho que não se reconhece (áudio **AAC**, que não tem marcador): pulado, procurando o próximo quadro pelo
     tamanho típico desses trechos na referência e por dois quadros encadeados.
3. A ordem de exibição (B-frames) sai do **POC** de cada quadro (`poc.js`: SPS/PPS da referência e os que vierem no
   vídeo); sem ele, do padrão de GOP da referência.
4. Um arquivo **novo** é gravado: `ftyp` + os dados copiados + um `moov` montado a partir do da referência, com as
   tabelas novas (sem `udta`/`meta` da referência, com a data do arquivo quebrado).

Recusa com mensagem: clipe que já tem índice, referência sem índice, referência de outro modo (quase nada reconhecido).

**Conferido** (`test/resgate.test.js` e testes manuais com ffmpeg): H.264 com B-frames + PCM (estilo Sony), H.265 +
PCM, ProRes + PCM 24 bits e H.264 + PCM + timecode voltam **idênticos ao original, quadro a quadro** (framemd5),
com som. H.264 + AAC (estilo iPhone/DJI) volta sem som e com o último quadro diferente quando o fim foi cortado.

**Ainda não:** áudio AAC (precisaria decodificar o AAC para achar as fronteiras), BRAW e R3D (formatos fechados),
clipes que as câmeras gravam em vários arquivos, e a sugestão automática da referência pelo número de série.

## Varredura por assinatura (`varredura.js`)

Lê o cartão (ou a imagem dele) de setor em setor (512 bytes) e reconhece cada arquivo pela estrutura:

| Formato | Como acha | Como sabe o tamanho |
|---|---|---|
| JPG | `FF D8 FF` | segue os marcadores até o `FF D9` (a miniatura dentro do EXIF não vira outro achado) |
| MP4, MOV, CR3, HEIC | caixa `ftyp` | caixas do topo em sequência; sem `moov` = **sem índice** (vai para o Consertar) |
| CR2, NEF, ARW, DNG, PEF, TIF | cabeçalho TIFF | o fim mais distante entre as IFDs, faixas, tiles, sub-IFDs, EXIF e a pré-visualização |

Depois de achar um arquivo, pula até o fim dele. Data e câmera vêm do EXIF (fotos) e do `mvhd` (vídeos) para o nome:
`recuperado_2026-10-12_1432_ILCE-7M4_0001.jpg`. `extrair` copia para outra pasta, nunca por cima de nada.

**Velocidade:** ~1,6 GB/s numa imagem em disco (o limite é o leitor de cartão).

**Ainda não:** a primeira passada pelo sistema de arquivos (exFAT/FAT32 com os nomes originais), a imagem bit a bit do
cartão com releitura dos setores ruins, ler o cartão "por baixo" (precisa do processo auxiliar com permissão de
administrador, §8.5), arquivos fragmentados e RAF/ORF/RW2.
