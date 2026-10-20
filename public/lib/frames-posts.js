// Frames → posts (tela Frames, aba Posts): os formatos que quem trabalha com audiovisual usa nas redes, desenhados num
// <canvas> em alta (2× o tamanho do Instagram) a partir dos frames originais. Sem nada de rede: só geometria e desenho.
//
//   triade      3, 4 ou 5 frames empilhados (o "stills" de filme), com respiro e o título embaixo; em tela cheia,
//               os frames ocupam o post inteiro, sem bordas nem título
//   grade       2×2 ou 3×3, colagem com respiro ou em tela cheia (colada)
//   polaroid    1 a 3 fotos instantâneas sobre o fundo, com legenda escrita embaixo
//   box         o frame dentro de uma moldura larga (passe-partout), com a ficha do filme em letras pequenas
//   cinema      o frame em 2,39:1 no meio, barras pretas e o título espaçado, como cartão de filme
//   contato     folha de contato: muitos frames pequenos com o timecode embaixo de cada um
//   carrossel   um frame só cortado em 2 ou 3 slides que, deslizando, viram uma imagem contínua

export const PROPORCOES = {
  '4:5': { w: 1080, h: 1350 },
  '1:1': { w: 1080, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
}

export const LAYOUTS = [
  { id: 'triade', nome: 'Tríade', dica: 'Frames empilhados', quantos: [3, 4, 5], padrao: 3 },
  { id: 'grade', nome: 'Grade', dica: 'Colagem 2×2 ou 3×3', quantos: [4, 9], padrao: 4 },
  { id: 'polaroid', nome: 'Polaroid', dica: 'Foto instantânea com legenda', quantos: [1, 2, 3], padrao: 1 },
  { id: 'box', nome: 'Box', dica: 'Moldura larga e ficha', quantos: [1], padrao: 1 },
  { id: 'cinema', nome: 'Cinema', dica: 'Scope 2,39:1 e título', quantos: [1], padrao: 1 },
  { id: 'contato', nome: 'Contato', dica: 'Folha de contato', quantos: [6, 9, 12], padrao: 9 },
  { id: 'carrossel', nome: 'Carrossel', dica: 'Um frame em slides contínuos', quantos: [1], padrao: 1, slides: [2, 3] },
]

export const layoutPorId = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0]

export const FUNDOS = { preto: { bg: '#0b0b0c', fg: '#f5f5f7', sub: 'rgba(245,245,247,0.55)' }, branco: { bg: '#f7f6f2', fg: '#111113', sub: 'rgba(17,17,19,0.5)' }, grafite: { bg: '#1f1f22', fg: '#f5f5f7', sub: 'rgba(245,245,247,0.5)' } }

/** Tamanho final do post (escala 2 = "em alta": 2160 × 2700 no 4:5). */
export function tamanhoPost(proporcao, escala = 2) {
  const p = PROPORCOES[proporcao] || PROPORCOES['4:5']
  return { w: p.w * escala, h: p.h * escala }
}

/**
 * Retângulo de origem para cobrir `w`×`h` (object-fit: cover), com o foco horizontal/vertical (0–1) e o zoom (1 = o
 * frame inteiro cabendo pelo lado menor; 2 = metade).
 */
export function cobrir(iw, ih, w, h, fx = 0.5, fy = 0.5, zoom = 1) {
  const r = Math.max(w / iw, h / ih) * Math.max(1, zoom)
  const sw = w / r
  const sh = h / r
  return { sx: (iw - sw) * fx, sy: (ih - sh) * fy, sw, sh }
}

/**
 * Onde cada frame entra (retângulos em px do post), sem desenhar: assim dá para testar e mostrar a prévia.
 * @returns {{ caixas: {x,y,w,h,rot?}[], texto?: {x,y,tam,alinha,peso,espaco}[], slides?: number }}
 */
export function montar(layout, { w, h, n, respiro = 0.03, slides = 2, cheio = false }) {
  const m = Math.round(w * respiro)
  switch (layout) {
    case 'triade': {
      // Tela cheia: faixas da largura toda, dividindo a altura inteira (sem fundo aparecendo).
      if (cheio) {
        const caixas = Array.from({ length: n }, (_, i) => {
          const y = Math.round((i * h) / n)
          return { x: 0, y, w, h: Math.round(((i + 1) * h) / n) - y }
        })
        return { caixas, texto: [] }
      }
      // Faixas de 16:9 empilhadas, centradas na altura que sobra; título embaixo.
      const fw = w - m * 2
      let fh = Math.round(fw * 9 / 16)
      const rodape = Math.round(w * 0.09)
      const cabe = Math.floor((h - rodape - m * 2 - m * (n - 1)) / n)
      if (fh > cabe) fh = cabe
      const total = fh * n + m * (n - 1)
      const y0 = Math.round((h - rodape - total) / 2)
      const caixas = Array.from({ length: n }, (_, i) => ({ x: Math.round((w - fw) / 2), y: y0 + i * (fh + m), w: fw, h: fh }))
      return { caixas, texto: [{ x: w / 2, y: y0 + total + Math.round(rodape * 0.62), tam: Math.round(w * 0.024), alinha: 'center', peso: 600, espaco: 0.32 }] }
    }
    case 'grade': {
      const lado = Math.round(Math.sqrt(n))
      const g = respiro && !cheio ? m : 0
      const cw = (w - g * (lado + 1)) / lado
      const ch = (h - g * (lado + 1)) / lado
      const caixas = []
      for (let r = 0; r < lado; r++) for (let c = 0; c < lado; c++) caixas.push({ x: Math.round(g + c * (cw + g)), y: Math.round(g + r * (ch + g)), w: Math.round(cw), h: Math.round(ch) })
      return { caixas }
    }
    case 'polaroid': {
      // Polaroid: foto quadrada-ish (4:3.6) com borda e base mais grossa. 2 ou 3 ficam espalhadas e giradas.
      const pw = Math.round(w * (n === 1 ? 0.74 : n === 2 ? 0.6 : 0.52))
      const borda = Math.round(pw * 0.055)
      const fw = pw - borda * 2
      const fh = Math.round(fw * 0.92)
      const ph = fh + borda + Math.round(pw * 0.23)
      const pos =
        n === 1
          ? [{ cx: w / 2, cy: h / 2, rot: -1.5 }]
          : n === 2
            ? [{ cx: w * 0.4, cy: h * 0.36, rot: -6 }, { cx: w * 0.6, cy: h * 0.64, rot: 5 }]
            : [{ cx: w * 0.38, cy: h * 0.27, rot: -7 }, { cx: w * 0.63, cy: h * 0.5, rot: 6 }, { cx: w * 0.4, cy: h * 0.74, rot: -3 }]
      const caixas = pos.map((p) => ({ x: Math.round(p.cx - pw / 2), y: Math.round(p.cy - ph / 2), w: pw, h: ph, rot: p.rot, foto: { x: borda, y: borda, w: fw, h: fh } }))
      return { caixas, texto: caixas.map((c) => ({ x: c.w / 2, y: c.foto.h + borda + (c.h - c.foto.h - borda) * 0.56, tam: Math.round(pw * 0.06), alinha: 'center', peso: 500, espaco: 0, dentro: true })) }
    }
    case 'box': {
      const lm = Math.round(w * 0.11)
      const fw = w - lm * 2
      const fh = Math.round(fw * 9 / 16)
      const y = Math.round((h - fh) / 2 - h * 0.03)
      return {
        caixas: [{ x: lm, y, w: fw, h: fh }],
        texto: [
          { x: lm, y: y + fh + Math.round(w * 0.06), tam: Math.round(w * 0.021), alinha: 'left', peso: 600, espaco: 0.24 },
          { x: w - lm, y: y + fh + Math.round(w * 0.06), tam: Math.round(w * 0.018), alinha: 'right', peso: 400, espaco: 0.18, sub: true },
        ],
      }
    }
    case 'cinema': {
      const fh = Math.round(w / 2.39)
      const y = Math.round((h - fh) / 2 - h * 0.04)
      return { caixas: [{ x: 0, y, w, h: fh }], texto: [{ x: w / 2, y: y + fh + Math.round(w * 0.1), tam: Math.round(w * 0.03), alinha: 'center', peso: 300, espaco: 0.6 }, { x: w / 2, y: y + fh + Math.round(w * 0.15), tam: Math.round(w * 0.016), alinha: 'center', peso: 500, espaco: 0.3, sub: true }] }
    }
    case 'contato': {
      const cols = 3
      const linhas = Math.ceil(n / cols)
      const topo = Math.round(h * 0.08)
      const leg = Math.round(w * 0.035)
      const g = Math.round(w * 0.022)
      const cw = (w - g * (cols + 1)) / cols
      let chh = Math.round(cw * 9 / 16)
      const cabe = (h - topo - g * 2 - (g + leg) * linhas) / linhas
      if (chh > cabe) chh = Math.floor(cabe)
      const total = linhas * (chh + leg + g) - g
      const y0 = topo + Math.round((h - topo - total) / 2)
      const caixas = []
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols)
        const c = i % cols
        caixas.push({ x: Math.round(g + c * (cw + g)), y: Math.round(y0 + r * (chh + leg + g)), w: Math.round(cw), h: chh, legenda: true })
      }
      return { caixas, texto: [{ x: g, y: Math.round(topo * 0.62), tam: Math.round(w * 0.02), alinha: 'left', peso: 600, espaco: 0.3 }], legenda: leg }
    }
    case 'carrossel': {
      // Uma imagem de `slides` × w por h, cortada depois em slides (desenhada inteira aqui).
      return { caixas: [{ x: 0, y: 0, w: w * slides, h }], slides }
    }
    default:
      return { caixas: [] }
  }
}

// ───── enquadramento de cada frame ─────
// Cada frame do post tem um enquadre { x, y, zoom }: x/y de 0 a 1 dizem que parte do frame aparece na caixa (0,5 =
// centro) e o zoom aproxima. Sem enquadre, o frame entra centralizado (com o `foco` horizontal do post).

export const ZOOM_MAX = 3
const entre = (v, a, b) => Math.min(b, Math.max(a, v))

/** O enquadre com os padrões preenchidos e os valores dentro dos limites. */
export function enquadreDe(e, foco = 0.5) {
  return { x: entre(Number.isFinite(e?.x) ? e.x : foco, 0, 1), y: entre(Number.isFinite(e?.y) ? e.y : 0.5, 0, 1), zoom: entre(Number.isFinite(e?.zoom) ? e.zoom : 1, 1, ZOOM_MAX) }
}

/**
 * Arrastar o frame dentro da caixa `b` (px do post): `dx`/`dy` é quanto o dedo andou, em px do post. O frame anda
 * junto com o dedo, até a borda dele encostar na borda da caixa.
 */
export function moverEnquadre(e, dx, dy, iw, ih, b) {
  const q = enquadreDe(e)
  const r = Math.max(b.w / iw, b.h / ih) * q.zoom
  const sobraX = iw * r - b.w
  const sobraY = ih * r - b.h
  return { ...q, x: sobraX > 0.5 ? entre(q.x - dx / sobraX, 0, 1) : q.x, y: sobraY > 0.5 ? entre(q.y - dy / sobraY, 0, 1) : q.y }
}

/**
 * Qual frame está no ponto (px do post, já na escala do desenho)? Devolve { i, caixa } ou null. A caixa é a área da
 * foto (na polaroid, a foto dentro da moldura, sem o giro). No carrossel, é sempre o frame 0 na largura toda.
 */
export function frameNoPonto(layout, { proporcao = '4:5', escala = 2, n, respiro = true, slides = 2, cheio = false }, px, py) {
  const { w, h } = tamanhoPost(proporcao, escala)
  const plano = montar(layout, { w, h, n, respiro: respiro ? 0.03 : 0, slides, cheio })
  for (let i = plano.caixas.length - 1; i >= 0; i--) {
    const c = plano.caixas[i]
    if (layout === 'polaroid') {
      // Desfaz o giro em volta do centro da moldura e confere dentro da foto.
      const cx = c.x + c.w / 2
      const cy = c.y + c.h / 2
      const a = (-(c.rot || 0) * Math.PI) / 180
      const lx = (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a) + c.w / 2
      const ly = (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a) + c.h / 2
      if (lx >= 0 && ly >= 0 && lx <= c.w && ly <= c.h) return { i, caixa: c.foto }
      continue
    }
    if (px >= c.x && py >= c.y && px <= c.x + c.w && py <= c.y + c.h) return { i: layout === 'carrossel' ? 0 : i, caixa: c }
  }
  return null
}

function desenharImagem(ctx, img, b, e) {
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  const s = cobrir(iw, ih, b.w, b.h, e.x, e.y, e.zoom)
  ctx.drawImage(img, s.sx, s.sy, s.sw, s.sh, b.x, b.y, b.w, b.h)
}

/** O contorno do frame em edição (só na prévia). */
function contornar(ctx, b) {
  const l = Math.max(2, Math.round(Math.min(b.w, b.h) * 0.012))
  ctx.save()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = l
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = l * 2
  ctx.strokeRect(b.x + l / 2, b.y + l / 2, b.w - l, b.h - l)
  ctx.restore()
}

function escrever(ctx, t, texto, cor) {
  if (!texto || !t) return
  ctx.save()
  ctx.fillStyle = cor
  ctx.font = `${t.peso} ${t.tam}px -apple-system, "SF Pro Display", "Inter", "Segoe UI", sans-serif`
  ctx.textAlign = t.alinha
  ctx.textBaseline = 'middle'
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(t.espaco * t.tam).toFixed(1)}px`
  ctx.fillText(texto, t.x, t.y)
  ctx.restore()
}

function logoNoCanto(ctx, logo, w, h, { tamanho = 0.14, posicao = 'inf-dir', opacidade = 0.9 } = {}) {
  if (!logo) return
  const lw = w * tamanho
  const lh = lw * ((logo.naturalHeight || logo.height) / (logo.naturalWidth || logo.width))
  const mx = w * 0.04
  const my = h * 0.03
  const x = posicao.endsWith('esq') ? mx : posicao === 'centro' ? (w - lw) / 2 : w - lw - mx
  const y = posicao.startsWith('sup') ? my : posicao === 'centro' ? (h - lh) / 2 : h - lh - my
  ctx.save()
  ctx.globalAlpha = opacidade
  ctx.drawImage(logo, x, y, lw, lh)
  ctx.restore()
}

/**
 * Desenha o post. `imagens`: HTMLImageElement já carregados (na ordem). `textos`: { titulo, sub, legendas[] }.
 * `enquadres[i]`: { x, y, zoom } do frame i (ver enquadreDe). `cheio`: tríade e grade em tela cheia, sem bordas. `destaque`: índice do frame que está sendo enquadrado
 * (ganha um contorno, só na prévia). Devolve o canvas (para o carrossel, a imagem inteira; `fatiar` corta em slides).
 */
export function desenharPost(canvas, { layout, proporcao = '4:5', escala = 2, imagens, fundo = 'preto', respiro = true, textos = {}, timecodes = [], logo = null, logoAjustes = null, slides = 2, foco = 0.5, enquadres = [], destaque = null, cheio = false }) {
  const { w, h } = tamanhoPost(proporcao, escala)
  const n = imagens.length
  const plano = montar(layout, { w, h, n, respiro: respiro ? 0.03 : 0, slides, cheio })
  const larg = layout === 'carrossel' ? w * slides : w
  canvas.width = larg
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const cor = FUNDOS[fundo] || FUNDOS.preto
  ctx.fillStyle = cor.bg
  ctx.fillRect(0, 0, larg, h)
  ctx.imageSmoothingQuality = 'high'

  if (layout === 'polaroid') {
    plano.caixas.forEach((c, i) => {
      const img = imagens[i]
      if (!img) return
      ctx.save()
      ctx.translate(c.x + c.w / 2, c.y + c.h / 2)
      ctx.rotate((c.rot * Math.PI) / 180)
      ctx.translate(-c.w / 2, -c.h / 2)
      ctx.shadowColor = 'rgba(0,0,0,0.35)'
      ctx.shadowBlur = c.w * 0.05
      ctx.shadowOffsetY = c.w * 0.015
      ctx.fillStyle = '#fbfaf6'
      ctx.fillRect(0, 0, c.w, c.h)
      ctx.shadowColor = 'transparent'
      desenharImagem(ctx, img, c.foto, enquadreDe(enquadres[i], foco))
      if (destaque === i) contornar(ctx, c.foto)
      const t = plano.texto[i]
      ctx.fillStyle = '#2a2a2a'
      ctx.font = `italic ${t.peso} ${t.tam}px "Bradley Hand", "Segoe Print", "Marker Felt", "Comic Sans MS", cursive`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const leg = textos.legendas?.[i] ?? (i === 0 ? textos.titulo : '')
      if (leg) ctx.fillText(leg, t.x, t.y, c.w * 0.86)
      ctx.restore()
    })
  } else {
    plano.caixas.forEach((c, i) => {
      const img = imagens[layout === 'carrossel' ? 0 : i]
      if (!img) return
      desenharImagem(ctx, img, c, enquadreDe(enquadres[layout === 'carrossel' ? 0 : i], layout === 'carrossel' ? 0.5 : foco))
      if (destaque === (layout === 'carrossel' ? 0 : i)) contornar(ctx, c)
      if (c.legenda) escrever(ctx, { x: c.x, y: c.y + c.h + plano.legenda * 0.55, tam: Math.round(plano.legenda * 0.42), alinha: 'left', peso: 500, espaco: 0.08 }, timecodes[i] ? timecodes[i].replace(/-/g, ':') : '', cor.sub)
    })
    const t = plano.texto || []
    if (layout === 'triade' || layout === 'contato') escrever(ctx, t[0], (textos.titulo || '').toUpperCase(), cor.fg)
    if (layout === 'box') {
      escrever(ctx, t[0], (textos.titulo || '').toUpperCase(), cor.fg)
      escrever(ctx, t[1], textos.sub || (timecodes[0] ? timecodes[0].replace(/-/g, ':') : ''), cor.sub)
    }
    if (layout === 'cinema') {
      escrever(ctx, t[0], (textos.titulo || '').toUpperCase(), cor.fg)
      escrever(ctx, t[1], (textos.sub || '').toUpperCase(), cor.sub)
    }
  }
  if (logo && layout !== 'carrossel') logoNoCanto(ctx, logo, w, h, logoAjustes || undefined)
  if (logo && layout === 'carrossel') logoNoCanto(ctx, logo, w, h, { ...(logoAjustes || {}), posicao: (logoAjustes?.posicao || 'inf-dir').replace('dir', 'esq') })
  return canvas
}

/** Corta o carrossel em slides (canvases do tamanho do post). */
export function fatiar(canvas, slides) {
  const w = canvas.width / slides
  return Array.from({ length: slides }, (_, i) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = canvas.height
    c.getContext('2d').drawImage(canvas, i * w, 0, w, canvas.height, 0, 0, w, canvas.height)
    return c
  })
}
