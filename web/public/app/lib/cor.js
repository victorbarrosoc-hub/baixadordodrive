// LOG → Rec.709 na prévia do celular (docs/COR.md). O aparelho mesmo descobre o perfil do vídeo:
//   1. metadados da câmera: os primeiros e os últimos 384 KB do original no Drive (Range), como no computador;
//   2. sem metadado: 3 quadros do vídeo tocando (LOG tem branco baixo e pouca cor).
// A conversão é a mesma LUT do computador (cor-lut.js), aplicada na placa de vídeo (cor-gl.js). Só a prévia muda.
import { LAN } from './config.js'
import { faixa } from './psd.js'
import { PEDACO, perfilDosBytes } from './cor-detectar.js'
import { PERFIS } from './cor-lut.js'

export { pareceLog } from './cor-detectar.js'
export { filtroCor } from './cor-gl.js'

/** Os perfis que convertem (Rec.709 não entra na lista). */
export const PERFIS_LOG = Object.entries(PERFIS).filter(([, p]) => p.curva)
export const nomePerfil = (p) => PERFIS[p]?.nome || 'LOG'
export const converte = (p) => Boolean(PERFIS[p]?.curva)

const idDe = (f) => f.shortcutDetails?.targetId || f.id
const lidos = new Map() // id:versão → perfil | null

/**
 * O perfil escrito pela câmera dentro do arquivo, ou null (sem metadado, ou não deu para ler). Lê só o começo e o fim.
 * @returns {Promise<string|null>}
 */
export async function perfilPelosMetadados(file, signal) {
  if (LAN) return null // pelo computador da rede não há Range no Drive
  const chave = `${idDe(file)}:${file.modifiedTime || ''}`
  if (lidos.has(chave)) return lidos.get(chave)
  const tam = Number(file.size || 0)
  let falhou = false
  const ler = (a, b) => faixa(idDe(file), a, b, { signal }).catch((err) => {
    if (signal?.aborted) throw err
    falhou = true
    return new Uint8Array(0)
  })
  const comeco = await ler(0, tam ? Math.min(tam, PEDACO) : PEDACO)
  const fim = tam > PEDACO * 2 ? await ler(tam - PEDACO, tam) : tam > PEDACO ? await ler(PEDACO, tam) : new Uint8Array(0)
  const junto = new Uint8Array(comeco.length + fim.length)
  junto.set(comeco)
  junto.set(fim, comeco.length)
  const p = perfilDosBytes(junto)
  if (p || !falhou) lidos.set(chave, p) // a rede falhou e não achou nada: tenta de novo na próxima vez
  return p
}

let tela = null
/** Um quadro do vídeo em RGB pequeno (para pareceLog), ou null se o navegador não deixar ler. */
export function quadroRgb(video, lado = 96) {
  if (!video?.videoWidth) return null
  try {
    tela ??= document.createElement('canvas')
    const esc = lado / Math.max(video.videoWidth, video.videoHeight)
    tela.width = Math.max(1, Math.round(video.videoWidth * esc))
    tela.height = Math.max(1, Math.round(video.videoHeight * esc))
    const ctx = tela.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(video, 0, 0, tela.width, tela.height)
    const rgba = ctx.getImageData(0, 0, tela.width, tela.height).data
    const rgb = new Uint8Array((rgba.length / 4) * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]
      rgb[j + 1] = rgba[i + 1]
      rgb[j + 2] = rgba[i + 2]
    }
    return rgb
  } catch {
    return null
  }
}

/** A câmera que a pessoa escolheu da última vez (para quando o app não sabe qual é). */
export function perfilLembrado() {
  try {
    const p = localStorage.getItem('previa.perfil')
    return converte(p) ? p : 'slog3-cine'
  } catch {
    return 'slog3-cine'
  }
}
export function lembrarPerfil(p) {
  try {
    localStorage.setItem('previa.perfil', p)
  } catch {
    // sem armazenamento: só não lembra
  }
}
