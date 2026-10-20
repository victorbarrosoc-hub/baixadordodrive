// Busca por cena: tira amostras do vídeo para o modelo, sem baixar o vídeo inteiro para o disco.
//
//   ffmpeg (entrada: arquivo ou a ponte local para o Drive, ponte.js: o token não vai nos argumentos)
//     -skip_frame nokey: decodifica só os quadros-chave (o proxy do app tem um a cada ~2 s; câmera, 0,5 a 1 s)
//     fps=1/passo ──┬──▶ 224×224 RGB (cobre e corta no meio, como o CLIP espera) ──▶ pipe:1
//                   └──▶ miniatura JPEG de 320 px ──▶ <pasta>/000001.jpg …
//
// Vídeo grande demais para ler inteiro pela rede (original de câmera sem proxy): um ffmpeg por amostra, pulando
// direto para o ponto (o Drive aceita Range), poucos ao mesmo tempo.
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LADO } from './modelo.js'

const QUADRO = LADO * LADO * 3

/**
 * Os argumentos de entrada do ffmpeg: arquivo local ou http(s) (a ponte). `soChave`: decodifica só os
 * quadros-chave (rápido para a passada inteira; depois de um -ss, daria o quadro-chave seguinte, não o ponto).
 */
export function entradaArgs(entrada, { ss = null, soChave = false } = {}) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (/^https?:/.test(entrada.url || '')) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4')
  if (ss != null) a.push('-ss', String(Math.max(0, ss)))
  if (soChave) a.push('-skip_frame', 'nokey')
  a.push('-i', entrada.url || entrada.caminho)
  return a
}

const filtroModelo = `scale=${LADO}:${LADO}:force_original_aspect_ratio=increase:flags=bicubic,crop=${LADO}:${LADO}`

/**
 * Material em LOG: a LUT (.cube, src/cor/lut.js) entra antes de tudo, para o modelo e a miniatura verem em Rec.709.
 * O ffmpeg roda na pasta da LUT e recebe só o nome (um caminho do Windows, com "C:\", quebraria o filtro).
 */
function comLut(lut) {
  if (!lut) return { pre: '', cwd: undefined }
  const nome = path.basename(lut)
  if (!/^[\w.-]+$/.test(nome)) throw new Error('nome de LUT inválido')
  return { pre: `format=rgb24,lut3d=file=${nome}:interp=tetrahedral,`, cwd: path.dirname(lut) }
}
const filtroMini = 'scale=320:-2:flags=bicubic'

/**
 * Amostras seguidas, numa passada só.
 * @param {object} o
 * @param {string} o.ffmpeg caminho do ffmpeg
 * @param {{ url?: string, caminho?: string }} o.entrada
 * @param {number} o.passo segundos entre amostras
 * @param {string} o.pastaMinis onde gravar as miniaturas (000001.jpg = amostra 0)
 * @param {(rgb: Buffer, k: number) => Promise<void>|void} o.onAmostra chamada em ordem; a passada espera (contrapressão)
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<number>} quantas amostras
 */
export async function amostrarSeguido({ ffmpeg, entrada, passo, pastaMinis, onAmostra, signal, lut = null }) {
  await fsp.mkdir(pastaMinis, { recursive: true })
  const L = comLut(lut)
  const args = [
    ...entradaArgs(entrada, { soChave: true }),
    '-an',
    '-sn',
    '-filter_complex',
    `[0:v:0]fps=1/${passo}:round=near,${L.pre}split=2[a][b];[a]${filtroModelo}[m];[b]${filtroMini}[t]`,
    '-map', '[m]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    '-map', '[t]', '-q:v', '5', '-f', 'image2', '-start_number', '1', path.join(pastaMinis, '%06d.jpg'),
  ]
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: L.cwd })
    let erro = ''
    let k = 0
    let resto = Buffer.alloc(0)
    let fila = Promise.resolve()
    let falhou = null
    const parar = () => p.kill('SIGKILL')
    signal?.addEventListener('abort', parar, { once: true })
    p.stderr.on('data', (d) => {
      erro = (erro + d).slice(-2000)
    })
    p.stdout.on('data', (chunk) => {
      resto = resto.length ? Buffer.concat([resto, chunk]) : chunk
      while (resto.length >= QUADRO) {
        const rgb = Buffer.from(resto.subarray(0, QUADRO))
        resto = resto.subarray(QUADRO)
        const i = k++
        p.stdout.pause()
        fila = fila
          .then(() => onAmostra(rgb, i))
          .catch((err) => {
            falhou = falhou || err
            parar()
          })
          .finally(() => p.stdout.resume())
      }
    })
    p.on('error', reject)
    p.on('close', async (code) => {
      signal?.removeEventListener('abort', parar)
      await fila
      if (signal?.aborted) return reject(Object.assign(new Error('parado'), { name: 'AbortError' }))
      if (falhou) return reject(falhou)
      if (code !== 0 && k === 0) return reject(new Error(`o ffmpeg não leu o vídeo: ${erro.trim().split('\n').pop() || code}`))
      resolve(k)
    })
  })
}

/** Uma amostra no ponto `t` (RGB do modelo e a miniatura), para vídeos grandes demais para ler inteiros. */
export function amostrarPonto({ ffmpeg, entrada, t, miniatura, signal, lut = null }) {
  const L = comLut(lut)
  const args = [
    ...entradaArgs(entrada, { ss: t }),
    '-an',
    '-sn',
    '-frames:v', '1',
    '-filter_complex', `[0:v:0]${L.pre}split=2[a][b];[a]${filtroModelo}[m];[b]${filtroMini}[t]`,
    '-map', '[m]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    '-map', '[t]', '-frames:v', '1', '-q:v', '5', '-y', miniatura,
  ]
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: L.cwd })
    const partes = []
    let erro = ''
    const parar = () => p.kill('SIGKILL')
    signal?.addEventListener('abort', parar, { once: true })
    p.stdout.on('data', (d) => partes.push(d))
    p.stderr.on('data', (d) => {
      erro = (erro + d).slice(-1000)
    })
    p.on('error', reject)
    p.on('close', (code) => {
      signal?.removeEventListener('abort', parar)
      if (signal?.aborted) return reject(Object.assign(new Error('parado'), { name: 'AbortError' }))
      const buf = Buffer.concat(partes)
      if (buf.length < QUADRO) return reject(new Error(`o ffmpeg não leu o ponto ${t}s: ${erro.trim().split('\n').pop() || code}`))
      resolve(buf.subarray(0, QUADRO))
    })
  })
}
