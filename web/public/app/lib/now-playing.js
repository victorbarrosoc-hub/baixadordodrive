// Tela bloqueada e Central de Controle: nome do take, pasta e miniatura no lugar de só "SOBEDESCE".
// Media Session API (iPhone 15+, Android). A miniatura vira uma imagem data: pequena, que o sistema lê sem
// depender do endereço da página (o blob: da prévia nem sempre chega lá).

const ART_PX = 512
const arts = new Map() // url da miniatura → Promise<{ src, sizes, type } | null>

export const hasMediaSession = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof MediaMetadata !== 'undefined'

/** Nome sem a extensão ("A001_C003.MP4" → "A001_C003"). */
export const takeName = (name = '') => name.replace(/\.[a-z0-9]{2,5}$/i, '') || name

function artOf(url) {
  if (!url) return Promise.resolve(null)
  let p = arts.get(url)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.referrerPolicy = 'no-referrer'
      img.onload = () => {
        try {
          const k = Math.min(1, ART_PX / Math.max(img.naturalWidth, img.naturalHeight))
          const w = Math.max(1, Math.round(img.naturalWidth * k))
          const h = Math.max(1, Math.round(img.naturalHeight * k))
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve({ src: c.toDataURL('image/jpeg', 0.85), sizes: `${w}x${h}`, type: 'image/jpeg' })
        } catch {
          resolve({ src: url, sizes: `${img.naturalWidth}x${img.naturalHeight}` }) // canvas bloqueado: tenta o endereço mesmo
        }
      }
      // Sem CORS no endereço do Google: entrega o endereço como está (o sistema baixa sozinho).
      img.onerror = () => resolve(/^https:/.test(url) ? { src: url } : null)
      img.src = url
    })
    arts.set(url, p)
    if (arts.size > 20) arts.delete(arts.keys().next().value)
  }
  return p
}

let owner = 0

/**
 * Mostra { title, album, art } na tela bloqueada. `media` (opcional): o <video>/<audio> que os botões de lá
 * comandam (play, pausa, ±10 s e arrastar). Devolve a limpeza: só apaga se ninguém tiver tomado o lugar.
 */
export function nowPlaying({ title, album, art }, media) {
  if (!hasMediaSession()) return () => {}
  const ms = navigator.mediaSession
  const me = ++owner
  const set = (artwork) => {
    if (owner !== me) return
    try {
      ms.metadata = new MediaMetadata({ title: title || 'SOBEDESCE', artist: album || '', album: 'SOBEDESCE', artwork: artwork ? [artwork] : [] })
    } catch {
      // navegador sem suporte a algum campo
    }
  }
  set(null)
  artOf(art).then(set)

  const handlers = media
    ? {
        play: () => media.play()?.catch?.(() => {}),
        pause: () => media.pause(),
        seekbackward: (d) => (media.currentTime = Math.max(0, media.currentTime - (d.seekOffset || 10))),
        seekforward: (d) => (media.currentTime = Math.min(media.duration || Infinity, media.currentTime + (d.seekOffset || 10))),
        seekto: (d) => {
          if (d.fastSeek && 'fastSeek' in media) media.fastSeek(d.seekTime)
          else media.currentTime = d.seekTime
        },
      }
    : {}
  for (const [k, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(k, fn)
    } catch {
      // ação que este sistema não conhece
    }
  }
  const pos = () => {
    if (owner !== me || !media || !Number.isFinite(media.duration) || !media.duration) return
    try {
      ms.setPositionState({ duration: media.duration, playbackRate: media.playbackRate || 1, position: Math.min(media.currentTime, media.duration) })
    } catch {
      // posição fora do intervalo enquanto troca de fonte
    }
  }
  const evs = ['loadedmetadata', 'play', 'pause', 'seeked', 'ratechange']
  if (media) for (const e of evs) media.addEventListener(e, pos)
  pos()

  return () => {
    if (media) for (const e of evs) media.removeEventListener(e, pos)
    if (owner !== me) return
    owner++
    try {
      ms.metadata = null
      for (const k of Object.keys(handlers)) ms.setActionHandler(k, null)
    } catch {
      // nada a limpar
    }
  }
}
