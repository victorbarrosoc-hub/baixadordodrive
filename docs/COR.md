# LOG → Rec.709

Quem grava em LOG sobe para o Drive um material lavado, cinza e sem contraste. O app converte para **Rec.709** sem mexer no
arquivo:

- **Na prévia** do Drive, no app do computador e no celular: o botão **Rec.709** no canto direito do player.
- **Na busca por cena**: a IA olha os quadros já convertidos, então acha cor de verdade ("flor vermelha no altar").

Não é correção de cor. É a mesma ideia da LUT 709 que vai no monitor da câmera: serve para ver.

## Como o app sabe que é LOG

1. **Metadados da câmera**, lendo só os primeiros e os últimos 384 KB do arquivo no Drive.
   - Sony grava um XML com `CaptureGammaEquation` (s-log3-cine, s-log3, rec709, s-cinetone…).
   - Panasonic, Canon, DJI, ARRI e Fuji escrevem o nome do LOG (V-Log, Canon Log 3, D-Log, LogC, F-Log).
2. **Pela imagem**, quando não há metadado: 3 quadros do vídeo. LOG tem branco baixo (os 2% mais claros abaixo de ~75%)
   e pouca saturação. Nesse caso o perfil é **LOG (genérico)**: curva da Sony, sem mexer no gamut.
3. Sem nada disso: Rec.709, sem conversão.

No celular a detecção roda no próprio aparelho: lê os mesmos 384 KB do começo e do fim pelo Drive (Range) e, sem
metadado, olha 3 quadros do vídeo enquanto ele toca (o botão liga sozinho em ~3 s).

Em qualquer caso dá para escolher a câmera na mão: no seletor ao lado do botão (prévia) ou em **Cor** no painel da busca.
A prévia lembra a última câmera escolhida.

## Perfis

| Perfil | Curva | Gamut |
| --- | --- | --- |
| Sony S-Log3 · S-Gamut3.Cine | S-Log3 | S-Gamut3.Cine |
| Sony S-Log3 · S-Gamut3 | S-Log3 | S-Gamut3 |
| Panasonic V-Log | V-Log | V-Gamut |
| Canon Log 3 | Canon Log 3 | Cinema Gamut |
| DJI D-Log | D-Log | D-Gamut |
| ARRI LogC3 (EI 800) | LogC3 | ARRI Wide Gamut 3 |
| Fujifilm F-Log | F-Log | Rec.2020 |
| LOG (genérico) | S-Log3 | sem conversão |

## Como funciona

```
RGB do vídeo (0–1)
  ──▶ curva LOG do fabricante → luz linear da cena            (src/cor/lut.js, fórmulas públicas)
  ──▶ matriz do gamut da câmera → primárias Rec.709           (calculada das coordenadas xy, D65)
  ──▶ curva de filme (aproximação do ACES, cinza 18% ≈ 44%)
  ──▶ gama 2,4
= LUT 3D 33×33×33
```

- **Busca por cena:** o app grava a LUT em `<dados>/cenas/lut/<perfil>-v1.cube` e o ffmpeg aplica com `lut3d`
  (tetraédrica) antes de reduzir os quadros. O índice guarda o perfil usado; trocar o perfil analisa de novo.
- **Prévia:** a mesma LUT (`public/lib/cor-lut.js`, cópia idêntica conferida em `test/cor.test.js`) vira uma textura 3D
  no WebGL2 (`public/lib/cor-gl.js`). Cada quadro novo do vídeo (`requestVideoFrameCallback`) é desenhado num canvas por
  cima do player. Vale para o original, a cópia leve e o proxy da câmera (o proxy grava no mesmo LOG).
- **Celular** (`web/public/app/lib/cor.js`): usa cópias idênticas da LUT, da detecção e do filtro
  (`cor-lut.js`, `cor-detectar.js`, `cor-gl.js`). A tela cheia do iPhone mostra só o `<video>`, sem o canvas; com o
  Rec.709 ligado, o player ocupa a tela dentro da página, com a conversão.
- **Rota:** `GET /api/cor/perfil?accountId&fileId` → `{ perfil, origem: 'metadados' | 'imagem' | 'padrao' }`. O
  ffmpeg lê pela mesma ponte local da busca por cena, sem receber o token do Google.

## Próximos passos

- Proxy (cópia leve 720p) já convertido para Rec.709, opcional, para quem abre o proxy fora do app.
