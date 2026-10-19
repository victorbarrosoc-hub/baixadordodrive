// Tira de quadros para o "hover scrub" (passar o cursor ou segurar o dedo na miniatura e ver o take correr, como no
// DaVinci): um JPEG só com 64 quadros do vídeo em grade (8 × 8, 240 px no lado maior), feito com o ffmpeg a partir do
// proxy (720p, decodifica rápido). Fica em Proxy/<nome>.quadros.jpg ao lado do proxy, com
// appProperties { sobedesce: 'quadros', original, proxy }; o original ganha { quadros: <id>, quadrosGrade: 'n.cols.w.h' }
// para a grade achar a tira sem nenhuma consulta a mais (app do computador e do celular).
//
// Nada aqui atrapalha o proxy: quem chama engole a falha (só uma linha no log).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { abortError } from '../util/backoff.js'
import { probe, runTool, splitExt } from './previa.js'

export const QUADROS_MARCA = 'quadros'
/** Quadros por tira e colunas da grade (8 linhas de 8). */
export const QUADROS_N = 64
export const QUADROS_COLS = 8
/** Lado maior de cada quadro (px): nítido numa miniatura de grade sem pesar (≈ 200–300 KB a tira). */
export const QUADROS_LADO = 240
/** Acima disso (s), só os quadros-chave do proxy (GOP de 2,5 s): uma hora sai em segundos, não em minutos. */
const SO_CHAVE_S = 300
const TIMEOUT_MS = 10 * 60_000

/** Nome da tira: o nome-base do original com .quadros.jpg. */
export function quadrosName(name) {
  return `${splitExt(String(name ?? '').normalize('NFC'))[0] || 'video'}.quadros.jpg`
}

/** Tamanho de cada quadro: lado maior = `lado`, proporção do vídeo, pares. */
export function celula(width, height, lado = QUADROS_LADO) {
  const w = Number(width) || 16
  const h = Number(height) || 9
  const par = n => Math.max(2, Math.round(n / 2) * 2)
  return w >= h ? { w: lado, h: par((lado * h) / w) } : { w: par((lado * w) / h), h: lado }
}

/** "64.8.240.136" ⇄ { n, cols, w, h } (vai em appProperties do original: texto curto). */
export const gradeTexto = g => `${g.n}.${g.cols}.${g.w}.${g.h}`
export function lerGrade(s) {
  const m = /^(\d{1,3})\.(\d{1,2})\.(\d{2,4})\.(\d{2,4})$/.exec(String(s ?? ''))
  if (!m) return null
  const [n, cols, w, h] = m.slice(1).map(Number)
  return n > 0 && cols > 0 && cols <= n ? { n, cols, w, h } : null
}

/** Linha de comando: quadros espaçados por igual (fps = n/duração), escala, grade, um JPEG. */
export function argsQuadros({ input, output, durationS, cel, n = QUADROS_N, cols = QUADROS_COLS }) {
  const rows = Math.ceil(n / cols)
  const a = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error']
  if (durationS > SO_CHAVE_S) a.push('-skip_frame', 'nokey')
  a.push('-i', input, '-an', '-sn', '-dn', '-map', '0:v:0')
  // A rotação do celular já vem aplicada na imagem (autorotate); `n/duração` com folga de 1 % para o último entrar.
  const fps = (n / Math.max(0.1, durationS)) * 1.01
  a.push('-vf', `fps=${fps.toFixed(6)},scale=${cel.w}:${cel.h},setsar=1,tile=${cols}x${rows}`)
  a.push('-frames:v', '1', '-q:v', '5', '-f', 'image2', output)
  return a
}

/**
 * Gera a tira de `file` (o proxy, de preferência) em `dir`. Lança com motivo curto ou AbortError.
 * @returns {Promise<{ path: string, size: number, grade: { n, cols, w, h } }>}
 */
export async function gerarQuadros(motor, file, { dir, signal, info = null } = {}) {
  if (!motor?.ffmpeg?.path) throw new Error('sem ffmpeg para a tira de quadros')
  const i = info || (await probe(motor, file, { signal }))
  if (!i?.video || !(i.durationS > 0)) throw new Error('não consegui ler a duração do vídeo')
  // Quadros girados (celular em pé): a imagem sai em pé, então troca largura e altura.
  const rot = Math.abs(i.rotation || 0) % 180 === 90
  const cel = celula(rot ? i.video.height : i.video.width, rot ? i.video.width : i.video.height)
  // Clipe curto: não repete o mesmo quadro (≈ 4 por segundo), mas sempre uma linha cheia pelo menos.
  const n = Math.min(QUADROS_N, Math.max(QUADROS_COLS, Math.ceil((i.durationS * 4) / QUADROS_COLS) * QUADROS_COLS))
  const output = path.join(dir, 'quadros.jpg')
  const r = await runTool(motor.ffmpeg.path, argsQuadros({ input: file, output, durationS: i.durationS, cel, n }), { signal, timeoutMs: TIMEOUT_MS })
  if (r.aborted) throw abortError(signal)
  if (r.timedOut) throw new Error('a tira de quadros passou do tempo')
  if (r.code !== 0) throw new Error(`a tira de quadros falhou: ${String(r.stderr || '').trim().split(/\r?\n/).pop()?.slice(0, 200) || `saiu com ${r.code}`}`)
  const st = await fsp.stat(output).catch(() => null)
  if (!st || st.size < 512) throw new Error('a tira de quadros saiu vazia')
  return { path: output, size: st.size, grade: { n, cols: QUADROS_COLS, w: cel.w, h: cel.h } }
}
