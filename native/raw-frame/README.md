# sobedesce-raw-frame

Decodificador de Blackmagic RAW do SOBEDESCE (C++17, Blackmagic RAW SDK 6.0). Gera a **miniatura** de `.braw` para o
Drive (`src/media/raw-thumb.js`) e os frames do **proxy** de `.braw` (`src/media/braw.js`, que passa para o ffmpeg).

| Modo | Saída |
|---|---|
| `--check` | 0 = a biblioteca da Blackmagic abriu; 2 = não achei |
| `--info --input <braw> --max-side <px>` | JSON numa linha: `width`, `height`, `frameRate`, `frames`, `outWidth`, `outHeight`, `gamma` |
| `--frames --input <braw> --max-side <px>` | todos os frames em RGBA 8 bits no stdout, em ordem, sem cabeçalho |
| `--input <braw> --output <jpg> --width <px> --max-bytes <n>` | miniatura JPEG (frame de ~1 s) |
| `--attrs --input <braw>` | diagnóstico: gamas e gamuts que o clipe aceita |

Códigos: 0 ok · 2 sem como (biblioteca ausente, clipe que ela não abre) · 3 falha · 64 uso errado.

- **Cor:** Rec.709 (gama e gamut), o visual do proxy que a câmera grava. Sem Rec.709 no clipe, "Blackmagic Design
  Video"; sem nenhum, o que o clipe tem.
- **Escala:** a menor do SDK (1/8, 1/4, 1/2) com o lado maior ≥ `max-side`; o ffmpeg reduz o resto.
- **Decodificação na CPU**, 3 frames em voo (o SDK já usa todos os núcleos em cada frame).
- **Biblioteca:** `--lib <pasta>`, `SOBEDESCE_BRAW_LIB`, `<pasta do executável>/BlackmagicRawAPI/` (a que vai no app) e
  depois a do Blackmagic RAW / DaVinci Resolve instalados.

## Build

`node scripts/raw-frame-build.mjs` (o CI roda antes do `dist`) baixa o SDK da Blackmagic com o cadastro do segredo
`BRAW_SDK_CADASTRO`, compila e testa no `sample.braw` do SDK. Saída em `build/raw-frame/<mac|win-x64|win-arm64>/`, que
o `electron-builder.yml` põe em `<Resources>/raw-frame/`.

**O SDK não entra no repositório.** A licença do Blackmagic RAW SDK deixa redistribuir as bibliotecas ("API Libraries")
junto do app e obras derivadas dos exemplos (este arquivo deriva do `ProcessClipCPU`, com a nota de licença dele), mas
não os headers nem o resto do SDK. Por isso o CI baixa a cada build.

No Linux (desenvolvimento), com o SDK extraído:

```sh
SDK=…/BlackmagicRAWSDK
g++ -std=c++17 -O2 -I"$SDK/Linux/Include" -Inative/raw-frame native/raw-frame/raw-frame.cpp \
  "$SDK/Linux/Include/BlackmagicRawAPIDispatch.cpp" -ldl -lpthread -o sobedesce-raw-frame
SOBEDESCE_RAW_HELPER=$PWD/sobedesce-raw-frame SOBEDESCE_BRAW_LIB="$SDK/Linux/Libraries" npm start
```

`third_party/stb_image_write.h`: stb v1.16 (domínio público / MIT), commit `2c980bb`.
