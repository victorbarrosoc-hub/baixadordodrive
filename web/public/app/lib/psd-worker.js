// Worker da imagem final do PSD (lib/psd.js): guarda os bytes do último PSD aberto e desenha a imagem inteira ou um
// recorte (prancheta) sem travar a tela.
import { desenhar, prepararComposta } from './psd-ler.js'

let atual = null // { id, composta }

self.onmessage = (e) => {
  const m = e.data
  try {
    if (m.tipo === 'carregar') {
      atual = { id: m.id, composta: prepararComposta(new Uint8Array(m.buf), m.cab) }
      return self.postMessage({ n: m.n, ok: true })
    }
    if (m.tipo === 'desenhar') {
      if (atual?.id !== m.id) return self.postMessage({ n: m.n, erro: 'sem_arquivo' })
      const img = desenhar(atual.composta, { rect: m.rect, max: m.max })
      return self.postMessage({ n: m.n, ok: true, img }, [img.rgba.buffer])
    }
    if (m.tipo === 'soltar') atual = null
  } catch (err) {
    self.postMessage({ n: m.n, erro: err?.message || String(err) })
  }
}
