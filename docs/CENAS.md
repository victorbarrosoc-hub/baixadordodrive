# Busca por cena

Na aba **Drive** do app do computador, **Procurar cenas** acha momentos nos vídeos escrevendo o que se quer, por
exemplo "noiva com o buquê", "DJ tocando", "criança entrando na cerimônia" ou "flor vermelha no altar". Ninguém precisa
etiquetar nada antes.

Tudo roda **neste computador**. O vídeo não vai para nenhum serviço de IA, e o índice fica em `<dados>/cenas/`.

## Como usar

1. Abra a pasta do trabalho no Drive e toque em **Procurar cenas**.
2. Toque em **Analisar os vídeos desta pasta**. Entram os vídeos dela e das subpastas, menos os proxies.
   - Na primeira vez, o app baixa a IA (~228 MB).
   - Cada vídeo é lido uma vez. Vídeos já analisados, na mesma versão, não são lidos de novo.
3. Escreva o que procura. Escolha **Nesta pasta** ou **Em tudo** (todos os vídeos analisados da conta).
4. Cada resultado mostra a miniatura, o tempo e uma barra de "quanto parece".
   - Vídeo gravado em LOG leva o selo **LOG → 709**: foi analisado já convertido (veja `docs/COR.md`).
   - Clicar abre a prévia já no ponto.
   - **Salvar trecho** corta do original, sem recodificar, para `Downloads/Cenas`.

## Como funciona (`src/cenas/`)

```
Analisar ──▶ fila (um vídeo por vez, servico.js)
  modelo (arquivos.js: baixa uma vez, versões fixas, SHA-256 conferido)
  ──▶ proxy do Drive se houver (procurarProxy), senão o original
  ──▶ perfil de cor (metadados da câmera ou imagem; ou o escolhido em "Cor"): LOG ganha a LUT para Rec.709 (docs/COR.md)
  ──▶ amostrar.js: ffmpeg lê pelo Drive (token no cabeçalho, sem baixar para o disco), só quadros-chave, uma amostra
      a cada 2 s em 224×224 + miniatura de 320 px (com a LUT, se for LOG)
      (original > 6 GB sem proxy: pula de ponto em ponto, até 600 pontos)
  ──▶ modelo.js: cada amostra vira 512 números (CLIP ViT-B/32, onnxruntime-node na CPU)
  ──▶ indice.js: amostras seguidas parecidas viram um trecho (até 20 s); vetores em 8 bits
  ──▶ <dados>/cenas/indices/<conta>_<arquivo>.json + minis/<conta>_<arquivo>/<n>.jpg
Procurar ──▶ texto.js (WordPiece) + modelo de texto multilíngue ──▶ 512 números ──▶ compara com os trechos
```

- **Modelos** (licenças MIT e Apache-2.0):
  - imagem: `Xenova/clip-vit-base-patch32`, `vision_model_quantized.onnx`
  - texto: `sentence-transformers/clip-ViT-B-32-multilingual-v1` (DistilBERT multilíngue, entende português; `model_qint8_arm64.onnx` + `2_Dense`)
- **Validação** com fotos reais (casamento, buquê, bolo, DJ, criança, guitarra): a primeira resposta acertou em 10 de 12 buscas em português, e nas outras 2 a certa ficou entre as 3 primeiras.
- **Tempos medidos:**
  - cada busca leva poucos ms
  - num vídeo de teste de 72 s, a análise levou 3 a 5 s
  - na CPU de teste, ~130 ms por amostra (pode variar por máquina)
- **Sistemas:** Mac com Apple Silicon e Windows (x64 e ARM). O `onnxruntime-node` não tem binário para Mac Intel; lá o painel avisa que a busca não roda.
- **Acerta bem:** pessoas e papéis visíveis, objetos, cores e lugares.
- **Médio:** ações rápidas, como "jogando o noivo pra cima". O modelo vê um quadro por vez.

## Rotas (`src/server/cenas.js`)

| Rota | O que faz |
| --- | --- |
| `GET /api/cenas` | estado (modelo, fila); também no SSE `cenas` |
| `POST /api/cenas/modelo` | baixa a IA agora |
| `POST /api/cenas/analisar` | `{ accountId, folderId, perfil? }` (`auto` ou um perfil de `docs/COR.md`) → `{ novos, prontos, total }` |
| `POST /api/cenas/parar` | para a análise |
| `GET /api/cenas/pasta?accountId&folderId` | vídeos já analisados da pasta |
| `POST /api/cenas/procurar` | `{ accountId, texto, fileIds? }` → `{ resultados: [{ fileId, nome, ini, fim, t, nota, item }] }` |
| `POST /api/cenas/trecho` | `{ accountId, fileId, ini, fim }` → `{ caminho }` |
| `POST /api/cenas/esquecer` | `{ accountId, fileId? }` |
| `GET /api/cenas/mini?accountId&fileId&i&k` | miniatura do trecho (chave da mídia) |
| `GET /api/cor/perfil?accountId&fileId` | perfil de cor do vídeo (`docs/COR.md`) |

## Empacotamento

- `onnxruntime-node` fica em `optionalDependencies`, com a versão fixa.
- O `.npmrc` pula o download de CUDA no Linux (`onnxruntime-node-install=skip`).
- No app, ele vai em `app.asar.unpacked` (`asarUnpack`), só com os binários do sistema certo.
- No Mac universal, o binário de Apple Silicon entra no `x64ArchFiles`.
- O teste de fumaça do app empacotado (`desktop/smoke.js`) carrega o runtime e roda um modelo de 78 bytes.

## Próximos passos

- **No celular (SOBE E DESCE):** subir o índice junto com a pasta e procurar pelo app do celular.
- **Conferência opcional na nuvem**, para ações difíceis: quadros das melhores respostas iriam para uma IA externa, só se a pessoa ligar.
