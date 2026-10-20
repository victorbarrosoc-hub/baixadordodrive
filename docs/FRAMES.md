# Frames

Do vídeo final aos frames, takes e posts. Tela **Frames** no app do computador (`public/components/frames.js`),
motor em `src/frames/`, rotas em `src/server/frames.js`.

## Sobe e desce

- **Desce:** o vídeo pode vir do Drive. O computador baixa para um temporário (`baixarOriginal`, o mesmo download
  segmentado das prévias), faz tudo e apaga o temporário no fim.
- **No computador:** a pasta fica em `Downloads/Frames/` (ou onde a pessoa escolher), para postar em alta.
- **Sobe:** a pasta pronta entra na fila de envio, ao lado do vídeo original no Drive ou na pasta escolhida.
  Pode subir no fim do trabalho (automático) ou depois, pelo botão "Subir pro Drive".

## A pasta

```
<Vídeo> — Frames e Takes/
  Frames/Cena 01 — Claro, Quente, Calmo/<Base>_C01_F001_00-00-03-12.jpg
  Takes/<Base>_C01_T01_00-00-03-12_9x16.mp4
  Posts/<Base>_Post_Tríade 3_4x5.jpg
  indice.csv
```

- `<Base>`: o nome do vídeo sem espaços nem símbolos (`Filme Final v3.mov` → `Filme_Final_v3`).
- `C03`: cena. `F012` / `T02`: número do frame ou do take. `00-01-23-12`: timecode (h-m-s-quadro).
- A pasta da cena leva as etiquetas automáticas (luz, cor, movimento) ou o nome que a pessoa der (vira a pasta).
- `indice.csv`: tipo, arquivo, cena, etiquetas, segundos, timecode, formato e nota. Abre no Excel com acentos.
- O que é do app (miniaturas, candidatos, descartados) fica em `~/.sobedesce/frames/<id>/`, fora da pasta entregue.

## O bom senso da escolha (`escolha.js`)

Uma leitura pequena do filme (256 px, até 4 amostras/s): nitidez (variância do Laplaciano), exposição, contraste,
cor, uma impressão digital (dHash) e a diferença para a amostra anterior.

- **Cenas:** corte onde a imagem salta bem acima do normal do vídeo, ou onde a luz/cor muda de uma vez.
- **Fica de fora:** tela preta, branca, estourada ou fechada demais; tela chapada (fusão, letreiro em fundo liso);
  desfocado ou tremido (nitidez abaixo de 35% da referência da própria cena, que não desce de 1/4 da do filme);
  a 0,35 s de um corte; repetido (dHash a menos de 10 bits de um já escolhido).
- **Espalhado:** cada cena ganha frames pela raiz do tempo dela; dentro da cena, um por trecho.
- Se faltar, completa com os que sobraram e, por último, com os só um pouco diferentes (a mais de 1 s). Qualidade
  não cede: pode sair menos do que o pedido, e a tela conta o que ficou de fora.
- **Takes:** a janela com a melhor nota média de cada cena; se pedir mais, outros trechos das cenas longas, sem
  encostar nos escolhidos.

## Em alta (`extracao.js`)

- Frame no tempo exato, no tamanho do arquivo: JPEG na qualidade máxima com cor 4:4:4, PNG ou TIFF (LZW).
- Take: H.264 em alta (o codificador de hardware do computador, sem o teto da prévia) ou ProRes 422 HQ;
  original, 9:16, 4:5 ou 1:1 (recorte pelo centro), fade curto, com ou sem som.
- Logomarca (PNG, JPG ou WebP): canto ou centro, tamanho e opacidade; nos frames, nos takes e nos posts.

## Na tela

- Frames por cena: abrir em tela cheia, **outro frame** (troca por um bom e diferente da mesma cena),
  **descartar** e voltar, **mais um** da cena, **frame num ponto** exato, nome da cena.
- Takes: passar o cursor toca; "também em" 9:16, 4:5, 1:1, original, ProRes ou H.264.
- Posts (`public/lib/frames-posts.js`, canvas em 2160 px): Tríade (3, 4, 5), Grade (2×2, 3×3), Polaroid (1 a 3),
  Box, Cinema (2,39:1), Contato e Carrossel contínuo (2 ou 3 slides). 4:5, 1:1 ou 9:16; fundo preto, branco ou
  grafite; título, legenda e logomarca. Usa os frames escolhidos na aba Frames ou escolhe sozinho.

## API

| Rota | O quê |
| --- | --- |
| `GET /api/frames` | trabalho atual e histórico |
| `POST /api/frames` | começa: `{ origem: { tipo: 'local', caminho } \| { tipo: 'drive', accountId, fileId }, ajustes }` |
| `DELETE /api/frames/job/:jobId` | para |
| `GET /api/frames/:id` | o trabalho (cenas, frames, takes, posts) |
| `DELETE /api/frames/:id` | tira da lista (a pasta fica) |
| `POST /api/frames/:id/descartar` · `mais` · `no-ponto` · `cena` · `take` | edições |
| `POST /api/frames/:id/post?tipo=&proporcao=` | corpo = PNG/JPEG do post |
| `POST /api/frames/:id/post/apagar` | tira um post |
| `POST /api/frames/:id/subir` | `{ para: 'junto' \| { accountId, folderId, driveId, name } }` |
| `GET /api/frames/:id/arquivo?p=\|mini=\|alta=&k=` | arquivo do trabalho (chave da mídia), com Range |
| `GET /api/frames-logo?p=&k=` | prévia da logomarca |

Progresso pelo SSE `frames`: `{ jobId, status, fase, frac, texto, video, manifestoId, erro }`.

## Ainda não

- Vídeo HDR (HLG/PQ) sai sem conversão de tom: o JPEG fica lavado. Por enquanto, use a versão SDR do filme.
- Frames pelo celular (o trabalho pesado precisa do ffmpeg do computador).
- "Outro frame" e "frame num ponto" de um vídeo que veio do Drive baixam o vídeo de novo (ele não fica no computador).
