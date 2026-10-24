// "Baixar como…": a mesma referência em outro tipo de arquivo (MP4 que abre em tudo, só o áudio em MP3 320 / WAV /
// M4A, a foto em JPG). Quem converte é o ffmpeg do app (o mesmo da prévia leve, src/media/previa.js), a partir do
// arquivo que já existe: o vídeo recém-baixado pelo yt-dlp (na hora de salvar, "Também salvar como") ou o original da
// coleção baixado do Drive ("Baixar como…" depois). Não volta à plataforma: nada de login, limite ou link que sumiu,
// e o yt-dlp não baixa o mesmo vídeo duas vezes.
//
//   MP3 320   → libmp3lame, 320 kbps CBR, ID3v2.3
//   WAV       → PCM 16 bits, 48 kHz (o padrão de edição de vídeo)
//   M4A       → o AAC do vídeo copiado sem perda (se já for AAC), senão AAC 256 kbps
//   MP4       → H.264 + AAC; já é H.264 8 bits 4:2:0 + AAC no tamanho pedido = só troca o contêiner (rápido, sem
//               perda); senão converte (libx264 CRF 18, ou o codificador de vídeo da máquina). 1080p / 720p = o lado
//               menor (vale para vertical: 1080 × 1920 já é "1080p").
//   JPG       → foto que já é JPEG vai como está; as outras (WebP, PNG, AVIF…) viram JPEG qualidade alta.
import fs from 'node:fs/promises'
import path from 'node:path'
import { abortError } from '../util/backoff.js'
import { parseProbe, runTool, timeoutFor } from '../media/previa.js'
import { limparNome, NOME_MAX } from './metadados.js'

/** Os formatos, na ordem do menu. `tipo`: para que arquivo vale (video = vídeo; foto = imagem; ambos = os dois). */
export const FORMATOS = Object.freeze({
  original: Object.freeze({ id: 'original', tipo: 'ambos', titulo: 'Original', sub: 'Como foi salvo', curto: 'Original', ext: null }),
  mp4: Object.freeze({ id: 'mp4', tipo: 'video', titulo: 'Vídeo MP4', sub: 'H.264 + AAC, melhor disponível', curto: 'MP4', ext: 'mp4', altura: null }),
  'mp4-1080': Object.freeze({ id: 'mp4-1080', tipo: 'video', titulo: 'Vídeo MP4 1080p', sub: 'H.264 + AAC, até 1080p', curto: 'MP4 1080p', ext: 'mp4', altura: 1080 }),
  'mp4-720': Object.freeze({ id: 'mp4-720', tipo: 'video', titulo: 'Vídeo MP4 720p', sub: 'H.264 + AAC, mais leve', curto: 'MP4 720p', ext: 'mp4', altura: 720 }),
  'mp3-320': Object.freeze({ id: 'mp3-320', tipo: 'video', audio: true, titulo: 'Só áudio MP3', sub: '320 kbps', curto: 'MP3 320', ext: 'mp3' }),
  wav: Object.freeze({ id: 'wav', tipo: 'video', audio: true, titulo: 'Só áudio WAV', sub: 'Sem perda, para edição', curto: 'WAV', ext: 'wav' }),
  m4a: Object.freeze({ id: 'm4a', tipo: 'video', audio: true, titulo: 'Só áudio M4A', sub: 'AAC', curto: 'M4A', ext: 'm4a' }),
  jpg: Object.freeze({ id: 'jpg', tipo: 'foto', titulo: 'Foto JPG', sub: 'Abre em qualquer lugar', curto: 'JPG', ext: 'jpg' }),
})

export const ehFormato = id => typeof id === 'string' && Object.hasOwn(FORMATOS, id)

/** O arquivo é vídeo, foto ou nenhum dos dois (pelo tipo do Drive ou pela extensão). */
export function tipoDoArquivo({ mimeType = '', name = '' } = {}) {
  const m = String(mimeType || '').toLowerCase()
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('image/')) return 'foto'
  const ext = path.extname(String(name || '')).toLowerCase()
  if (['.mp4', '.m4v', '.mov', '.mkv', '.webm'].includes(ext)) return 'video'
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif'].includes(ext)) return 'foto'
  return null
}

/** Formatos que valem para este tipo de arquivo ('video' | 'foto'), na ordem do menu. */
export function formatosPara(tipo) {
  return Object.values(FORMATOS)
    .filter(f => f.tipo === 'ambos' || f.tipo === tipo)
    .map(f => f.id)
}

/** O formato vale para este arquivo? */
export const formatoServe = (id, tipo) => ehFormato(id) && formatosPara(tipo).includes(id)

/**
 * Lista de formatos vinda da interface, do celular ou da fila do site: só os conhecidos, sem repetir, sem o original
 * (ele sempre vai), no máximo `max`.
 */
export function limparFormatos(lista, { max = 6 } = {}) {
  if (!Array.isArray(lista)) return []
  const out = []
  for (const id of lista) if (ehFormato(id) && id !== 'original' && !out.includes(id)) out.push(id)
  return out.slice(0, max)
}

/**
 * Nome do convertido, ao lado do original: "Autor - Título (Instagram).mp4" + MP3 320 →
 * "Autor - Título (Instagram) (MP3 320).mp3". Cabe nos 120 caracteres do nome das referências.
 */
export function nomeConvertido(nome, id) {
  const f = FORMATOS[id]
  if (!f?.ext) throw new Error(`formato sem arquivo próprio: ${id}`)
  const base = limparNome(String(nome || '').replace(/\.[a-z0-9]{1,5}$/i, '')) || 'Referência'
  const sufixo = ` (${f.curto}).${f.ext}`
  const cabe = NOME_MAX - [...sufixo].length
  const chars = [...base]
  const b = chars.length > cabe ? `${chars.slice(0, cabe - 1).join('').trimEnd()}…` : base
  return `${b}${sufixo}`
}

// ─────────── erros ───────────

/** Erro da conversão com frase curta para a pessoa (`message`) e o detalhe técnico (`detalhe`, só para o log). */
export class FormatoError extends Error {
  constructor(codigo, message, { detalhe = '' } = {}) {
    super(message)
    this.name = 'FormatoError'
    this.codigo = codigo
    this.detalhe = detalhe
  }
}

export const MSG_FORMATO = {
  semFfmpeg: 'Para converter, falta o ffmpeg neste computador. Atualize o SOBEDESCE.',
  naoAbriu: 'Não consegui abrir o arquivo para converter.',
  semAudio: 'Este vídeo não tem áudio.',
  semVideo: 'Este arquivo não tem imagem de vídeo.',
  semMp3: 'O ffmpeg deste computador não gera MP3. Atualize o SOBEDESCE.',
  semH264: 'O ffmpeg deste computador não gera H.264. Atualize o SOBEDESCE.',
  tempo: 'A conversão demorou demais e foi interrompida.',
  naoServe: 'Esse formato não vale para este arquivo.',
}

// ─────────── olhar o arquivo ───────────

/** Primeira trilha de áudio de `ffmpeg -i`: codec, frequência e canais ("aac", 44100, "stereo"). */
export function lerAudio(texto) {
  const m = /Stream #\d+:\d+.*?: Audio: ([\w-]+)[^,\n]*(?:,\s*(\d+) Hz)?(?:,\s*([^,\n]+))?/.exec(String(texto ?? ''))
  if (!m) return null
  return { codec: m[1].toLowerCase(), hz: m[2] ? Number(m[2]) : null, canais: m[3] ? m[3].trim().toLowerCase() : null }
}

/** `ffmpeg -i` → { ...parseProbe, audioInfo }. null = o ffmpeg nem abriu (não é mídia, arquivo estragado). */
export async function sondar(ffmpeg, file, { signal, run = runTool } = {}) {
  const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeoutMs: 60_000, signal })
  if (r.aborted) throw abortError(signal)
  if (r.error) throw new FormatoError('sem_ffmpeg', MSG_FORMATO.semFfmpeg, { detalhe: String(r.error.code || r.error.message) })
  const info = parseProbe(r.stderr)
  if (!info.video && !info.audio && info.durationS == null) return null
  return { ...info, audioInfo: info.audio ? lerAudio(r.stderr) : null }
}

/** Nomes dos codificadores deste ffmpeg (libmp3lame, libx264, h264_videotoolbox…), lidos uma vez por caminho. */
const cacheCodificadores = new Map()
export async function codificadores(ffmpeg, { run = runTool, signal } = {}) {
  if (!ffmpeg) return new Set()
  if (cacheCodificadores.has(ffmpeg)) return cacheCodificadores.get(ffmpeg)
  const r = await run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15_000, signal, lowPriority: false })
  const nomes = new Set()
  for (const linha of String(r.stdout || '').split(/\r?\n/)) {
    const m = /^\s*[VAS][\w.]{5}\s+(\S+)/.exec(linha)
    if (m) nomes.add(m[1])
  }
  if (r.code === 0 && nomes.size) cacheCodificadores.set(ffmpeg, nomes)
  return nomes
}

// ─────────── argumentos ───────────

const INICIO = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats']
const SO_AUDIO = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_chapters', '-1']

/** A foto já é JPEG (pelo tipo do Drive; sem ele, pela extensão)? */
const jaEJpeg = (mimeType, nome) => /^image\/jpe?g$/i.test(mimeType || '') || (!mimeType && /\.jpe?g$/i.test(nome || ''))

/** H.264 8 bits 4:2:0: o que abre em qualquer editor, no QuickTime, no Windows e no celular. */
export const h264Comum = v => v?.codec === 'h264' && (v.bits == null || v.bits === 8) && (!v.pixFmt || /^(yuvj?420p|nv12)$/.test(v.pixFmt))

/** Taxa para os codificadores de hardware (eles não têm CRF igual ao libx264): pelo lado menor da saída. */
function taxa(ladoMenor) {
  if (!ladoMenor || ladoMenor >= 1080) return ['10M', '15M', '20M']
  if (ladoMenor >= 720) return ['6M', '9M', '12M']
  return ['4M', '6M', '8M']
}

/** Parâmetros de qualidade de cada codificador de H.264 (o arquivo é para usar, não uma prévia). */
export function codificadorVideo(encoder, ladoMenor = null) {
  const [b, max, buf] = taxa(ladoMenor)
  switch (encoder) {
    case 'h264_videotoolbox':
      return ['-c:v', encoder, '-b:v', b, '-maxrate', max, '-profile:v', 'high', '-allow_sw', '1', '-realtime', '0']
    case 'h264_nvenc':
      return ['-c:v', encoder, '-preset', 'p6', '-rc', 'vbr', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-profile:v', 'high']
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', 'slow', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-profile:v', 'high']
    case 'h264_amf':
      return ['-c:v', encoder, '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', b, '-maxrate', max, '-bufsize', buf, '-profile:v', 'high']
    case 'h264_mf':
      return ['-c:v', encoder, '-hw_encoding', '1', '-rate_control', 'u_vbr', '-b:v', b]
    case 'libx264':
    default:
      return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-profile:v', 'high']
  }
}

/** Lado menor da saída do MP4 (para a taxa do hardware): o do vídeo, ou o limite pedido se ele for maior. */
function ladoMenorSaida(v, altura) {
  const menor = v?.width && v?.height ? Math.min(v.width, v.height) : null
  if (!altura) return menor
  return menor ? Math.min(menor, altura) : altura
}

/**
 * Linha de comando do ffmpeg para um formato (sem shell). Devolve { args, modo: 'copia' | 'converte' } ou
 * { modo: 'arquivo' } (a foto JPEG já é o resultado: só copiar). Lança FormatoError se o arquivo não serve.
 * @param {{ formato: string, entrada: string, saida: string, info: object, encoder?: string, mimeType?: string }} o
 */
export function argsFormato({ formato, entrada, saida, info, encoder = 'libx264', mimeType = '' }) {
  const f = FORMATOS[formato]
  if (!f?.ext) throw new FormatoError('formato', MSG_FORMATO.naoServe)
  const a = info?.audioInfo || null
  if (f.audio) {
    if (!info?.audio) throw new FormatoError('sem_audio', MSG_FORMATO.semAudio)
    const head = [...INICIO, '-i', entrada, ...SO_AUDIO]
    if (formato === 'mp3-320') {
      // CBR 320k (o libmp3lame só faz VBR com -q:a; com -b:a é taxa constante). MP3 vai até 48 kHz e 2 canais.
      const extra = []
      if (a?.hz && a.hz > 48000) extra.push('-ar', '48000')
      if (!a?.canais || !/^(mono|stereo)$/.test(a.canais)) extra.push('-ac', '2')
      return { modo: 'converte', args: [...head, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k', ...extra, '-id3v2_version', '3', '-f', 'mp3', saida] }
    }
    if (formato === 'wav') return { modo: 'converte', args: [...head, '-map_metadata', '-1', '-c:a', 'pcm_s16le', '-ar', '48000', '-f', 'wav', saida] }
    // M4A: o AAC que já veio no vídeo é copiado (sem perda, na hora); outro codec vira AAC 256k.
    const copia = a?.codec === 'aac'
    return {
      modo: copia ? 'copia' : 'converte',
      args: [...head, ...(copia ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k', ...(a?.canais && /^(mono|stereo)$/.test(a.canais) ? [] : ['-ac', '2'])]), '-movflags', '+faststart', '-f', 'ipod', saida],
    }
  }
  if (f.tipo === 'foto') {
    if (jaEJpeg(mimeType, entrada)) return { modo: 'arquivo' }
    if (!info?.video) throw new FormatoError('nao_abriu', MSG_FORMATO.naoAbriu)
    return { modo: 'converte', args: [...INICIO, '-i', entrada, '-map', '0:v:0', '-frames:v', '1', '-vf', 'format=yuvj420p', '-c:v', 'mjpeg', '-q:v', '2', '-update', '1', '-f', 'image2', saida] }
  }
  // MP4 (H.264 + AAC)
  const v = info?.video
  if (!v) throw new FormatoError('sem_video', MSG_FORMATO.semVideo)
  const menor = v.width && v.height ? Math.min(v.width, v.height) : null
  const cabe = !f.altura || (menor != null && menor <= f.altura)
  const quadrado = !v.sar || v.sar[0] === v.sar[1]
  const audio = info.audio
  const audioArgs = !audio ? ['-an'] : a?.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', ...(a?.canais && /^(mono|stereo)$/.test(a.canais) ? [] : ['-ac', '2'])]
  const fim = ['-dn', '-sn', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', saida]
  const mapas = ['-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : [])]
  if (h264Comum(v) && cabe && quadrado) {
    // Já é o que se pediu: troca só o contêiner (o vídeo não perde nada e sai na hora).
    return { modo: 'copia', args: [...INICIO, '-i', entrada, ...mapas, '-c:v', 'copy', ...audioArgs, ...fim] }
  }
  const filtros = []
  if (!quadrado) filtros.push("scale=w='trunc(iw*sar/2)*2':h=ih", 'setsar=1')
  if (f.altura && !cabe) {
    // O lado menor vira o limite (vertical: a largura), o outro acompanha e fica par.
    filtros.push(`scale=w='if(gte(iw,ih),-2,${f.altura})':h='if(gte(iw,ih),${f.altura},-2)'`)
  } else filtros.push("scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'")
  filtros.push(`format=${encoder === 'h264_qsv' || encoder === 'h264_mf' ? 'nv12' : 'yuv420p'}`)
  return {
    modo: 'converte',
    args: [...INICIO, '-i', entrada, ...mapas, '-vf', filtros.join(','), ...codificadorVideo(encoder, ladoMenorSaida(v, f.altura)), ...audioArgs, ...fim],
  }
}

/** Codificadores de H.264 para tentar, do de melhor qualidade ao da máquina: libx264 primeiro, hardware depois. */
export function planoVideo(nomes, motorEncoder = null) {
  const out = []
  if (nomes.has('libx264')) out.push('libx264')
  if (motorEncoder && motorEncoder !== 'libx264' && nomes.has(motorEncoder)) out.push(motorEncoder)
  for (const e of ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']) if (!out.length && nomes.has(e)) out.push(e)
  return out
}

/** Última linha útil do stderr. */
function ultimaLinha(texto) {
  const l = String(texto || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  return (l[l.length - 1] || '').slice(0, 300)
}

/**
 * Converte `entrada` em `saida` no formato pedido. Devolve { modo, encoder, info }. Lança FormatoError (frase curta)
 * ou AbortError. `onProgress(0..1)`.
 * @param {{ ffmpeg: string|null, formato: string, entrada: string, saida: string, mimeType?: string, motorEncoder?: string|null,
 *   signal?: AbortSignal, onProgress?: Function, run?: Function, log?: Function }} o
 */
export async function converterFormato({ ffmpeg, formato, entrada, saida, mimeType = '', motorEncoder = null, signal, onProgress, run = runTool, log = () => {} }) {
  const f = FORMATOS[formato]
  if (!f?.ext) throw new FormatoError('formato', MSG_FORMATO.naoServe)
  if (signal?.aborted) throw abortError(signal)
  // Foto que já é JPEG: o resultado é ela mesma (não precisa nem do ffmpeg).
  if (f.tipo === 'foto' && jaEJpeg(mimeType, entrada)) {
    await fs.copyFile(entrada, saida)
    onProgress?.(1)
    return { modo: 'arquivo', encoder: null, info: null }
  }
  if (!ffmpeg) throw new FormatoError('sem_ffmpeg', MSG_FORMATO.semFfmpeg)
  const info = await sondar(ffmpeg, entrada, { signal, run })
  if (!info) throw new FormatoError('nao_abriu', MSG_FORMATO.naoAbriu)
  const nomes = await codificadores(ffmpeg, { run, signal })
  if (formato === 'mp3-320' && !nomes.has('libmp3lame')) throw new FormatoError('sem_codificador', MSG_FORMATO.semMp3)
  // Tentativas: o plano de vídeo só importa quando o MP4 precisa converter de verdade.
  let tentativas = [null]
  if (f.tipo === 'video' && !f.audio) {
    const prova = argsFormato({ formato, entrada, saida, info, mimeType })
    if (prova.modo === 'converte') {
      tentativas = planoVideo(nomes, motorEncoder)
      if (!tentativas.length) throw new FormatoError('sem_codificador', MSG_FORMATO.semH264)
    }
  }
  const dur = info.durationS || 0
  let ultimo = null
  for (const encoder of tentativas) {
    const plano = argsFormato({ formato, entrada, saida, info, mimeType, ...(encoder ? { encoder } : {}) })
    await fs.rm(saida, { force: true })
    let buf = ''
    const r = await run(ffmpeg, plano.args, {
      signal,
      timeoutMs: timeoutFor(dur),
      stallMs: 5 * 60_000,
      onStdout: s => {
        buf += s
        const linhas = buf.split('\n')
        buf = linhas.pop()
        for (const l of linhas) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(l.trim())
          if (m && dur > 0) onProgress?.(Math.min(0.999, Number(m[1]) / 1e6 / dur))
        }
      },
    })
    if (r.aborted || signal?.aborted) throw abortError(signal)
    if (r.timedOut || r.stalled) throw new FormatoError('tempo', MSG_FORMATO.tempo)
    if (r.error) throw new FormatoError('sem_ffmpeg', MSG_FORMATO.semFfmpeg, { detalhe: String(r.error.code || r.error.message) })
    const st = await fs.stat(saida).catch(() => null)
    if (r.code === 0 && st?.size > 0) {
      onProgress?.(1)
      return { modo: plano.modo, encoder, info }
    }
    ultimo = new FormatoError('conversao', `Não consegui converter para ${f.curto}.`, { detalhe: `${encoder ? `${encoder}: ` : ''}${ultimaLinha(r.stderr) || `saiu com ${r.code}`}` })
    log(`conversão (${formato}) falhou: ${ultimo.detalhe}`)
  }
  await fs.rm(saida, { force: true }).catch(() => {})
  throw ultimo
}
