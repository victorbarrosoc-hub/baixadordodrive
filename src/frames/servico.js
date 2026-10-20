// Frames (docs/FRAMES.md): o trabalho inteiro de um vídeo, do começo ao fim.
//
//   1. pega o vídeo (do computador ou baixado do Drive para um temporário);
//   2. lê o filme em pequeno (analise.js), separa as cenas e escolhe os quadros e os takes com bom senso (escolha.js);
//   3. tira tudo em alta do arquivo (extracao.js) para uma pasta organizada:
//        <Vídeo> — Frames e Takes/
//          Frames/Cena 01 — Claro, Quente, Calmo/<Base>_C01_F001_00-00-03-12.jpg
//          Takes/<Base>_C01_T01_00-00-03-12_9x16.mp4
//          Posts/                      (as artes montadas na tela)
//          indice.csv                  (arquivo, cena, etiquetas, tempo, timecode, nota)
//   4. sobe a pasta para o Drive se a pessoa pediu (ao lado do vídeo original, ou onde ela escolheu).
//
// O que é do app (miniaturas, candidatos de cada cena, descartados) fica na pasta de dados, fora da pasta entregue:
// a pasta que sobe para o Drive só tem o que serve para postar e editar.
import fs from 'node:fs/promises'
import path from 'node:path'
import { newId } from '../util/ids.js'
import { safeLocalName, uniqueName } from '../util/paths.js'
import { readJSON, writeJSONAtomic } from '../util/store.js'
import { amostrar, cenas as separarCenas, distanciaHash, sondar } from './analise.js'
import { escolherFrames, escolherTakes, etiquetas, nota, refPorCena } from './escolha.js'
import { extrairFrame, extrairTake, miniatura, timecode } from './extracao.js'

export const FORMATOS_FRAME = ['jpg', 'png', 'tiff']
export const FORMATOS_TAKE = ['original', '9:16', '4:5', '1:1']
export const POSICOES_LOGO = ['inf-dir', 'inf-esq', 'sup-dir', 'sup-esq', 'centro']
const HISTORICO_MAX = 60
const CANDIDATOS_POR_CENA = 40
const HASH_IGUAL = 10
const PARALELO = 3

export class FramesError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'FramesError'
    this.status = status
  }
}

/** "Filme Final v3 (cor).mov" → "Filme_Final_v3_cor" (para o nome dos arquivos). */
export function baseDoNome(nome) {
  const stem = String(nome || 'video').replace(/\.[^.]{1,6}$/, '')
  const b = stem
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48)
  return b || 'video'
}

const dd = (n, w = 2) => String(n).padStart(w, '0')

/** Nome da pasta de uma cena: "Cena 03 — Escuro, Frio, Parado" ou "Cena 03 — Praia" (nome dado pela pessoa). */
export function pastaDaCena(n, rotulo) {
  const r = safeLocalName(String(rotulo || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60), 'win32')
  return r && r !== '_' ? `Cena ${dd(n)} — ${r}` : `Cena ${dd(n)}`
}

const csv = (v) => {
  const s = String(v ?? '')
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function pool(itens, n, fn) {
  let i = 0
  const run = async () => {
    while (i < itens.length) {
      const k = i++
      await fn(itens[k], k)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, run))
}

const existe = (p) => fs.stat(p).then(() => true, () => false)

/**
 * @param {object} o
 * @param {string} o.dataRoot pasta de dados do app (miniaturas, manifestos e o histórico ficam em <dataRoot>/frames)
 * @param {() => Promise<object>} o.motor detectarMotor() (ffmpeg e o codificador de H.264 deste computador)
 * @param {(accountId: string) => object} o.drive cliente do Drive da conta
 * @param {(drive, item, opts) => Promise<{ path: string, limpar: () => Promise<void> }>} o.baixar baixa um arquivo do Drive
 * @param {(o: { accountId, pasta, folderId, driveId, name }) => Promise<object>} o.subir põe a pasta na fila de envio
 * @param {() => string} o.pastaPadrao onde as pastas novas ficam (Downloads/Frames)
 * @param {(view) => void} o.onChange progresso (SSE 'frames')
 */
export class FramesService {
  constructor({ dataRoot, motor, drive, baixar, subir, pastaPadrao, onChange = () => {}, log = () => {} }) {
    this.root = path.join(dataRoot, 'frames')
    this.motor = motor
    this.drive = drive
    this.baixar = baixar
    this.subir = subir
    this.pastaPadrao = pastaPadrao
    this.onChange = onChange
    this.log = log
    this.job = null
    this.cache = new Map() // id → manifesto
    this.fila = Promise.resolve() // edições de um manifesto, uma de cada vez
  }

  dirDe(id) {
    if (!/^frm_[\w-]{4,64}$/.test(id)) throw new FramesError('Esse trabalho não existe.', 404)
    return path.join(this.root, id)
  }

  // ── histórico

  async historico() {
    const h = await readJSON(path.join(this.root, 'historico.json'), [])
    return Array.isArray(h) ? h : []
  }

  async #lembrar(m) {
    const h = (await this.historico()).filter((x) => x.id !== m.id)
    h.unshift(this.resumo(m))
    await fs.mkdir(this.root, { recursive: true })
    await writeJSONAtomic(path.join(this.root, 'historico.json'), h.slice(0, HISTORICO_MAX))
  }

  async esquecer(id) {
    const dir = this.dirDe(id)
    const h = (await this.historico()).filter((x) => x.id !== id)
    await writeJSONAtomic(path.join(this.root, 'historico.json'), h)
    this.cache.delete(id)
    await fs.rm(dir, { recursive: true, force: true })
  }

  resumo(m) {
    const ativos = m.frames.filter((f) => !f.descartado)
    return {
      id: m.id,
      criado: m.criado,
      video: { nome: m.video.nome, origem: m.video.origem, duracaoS: m.video.duracaoS },
      pasta: m.pasta,
      frames: ativos.length,
      takes: m.takes.filter((t) => !t.descartado).length,
      posts: m.posts.length,
      capa: ativos[0]?.id ?? null,
      drive: m.drive ?? null,
    }
  }

  async manifesto(id) {
    if (this.cache.has(id)) return this.cache.get(id)
    const m = await readJSON(path.join(this.dirDe(id), 'manifesto.json'), null)
    if (!m) throw new FramesError('Esse trabalho não existe mais.', 404)
    this.cache.set(id, m)
    return m
  }

  async #salvar(m) {
    this.cache.set(m.id, m)
    await writeJSONAtomic(path.join(this.dirDe(m.id), 'manifesto.json'), m, { space: 0 })
    await this.#indice(m)
    await this.#lembrar(m)
  }

  /** Uma edição por vez (trocar, descartar, renomear, salvar post): nada se perde se a tela mandar duas juntas. */
  #emFila(fn) {
    const p = this.fila.then(fn, fn)
    this.fila = p.catch(() => {})
    return p
  }

  async #indice(m) {
    const linhas = [['tipo', 'arquivo', 'cena', 'etiquetas', 'segundos', 'timecode', 'formato', 'nota'].join(';')]
    const cena = (n) => m.cenas.find((c) => c.n === n)
    for (const f of m.frames.filter((x) => !x.descartado))
      linhas.push(['frame', f.arquivo, dd(f.cena), (cena(f.cena)?.nome || cena(f.cena)?.tags.join(', ')) ?? '', f.t.toFixed(3), f.tc, m.ajustes.frames.formato, f.nota.toFixed(2)].map(csv).join(';'))
    for (const t of m.takes.filter((x) => !x.descartado))
      linhas.push(['take', t.arquivo, dd(t.cena), (cena(t.cena)?.nome || cena(t.cena)?.tags.join(', ')) ?? '', t.ini.toFixed(3), t.tc, `${t.formato} ${t.codec}`, t.nota.toFixed(2)].map(csv).join(';'))
    for (const p of m.posts) linhas.push(['post', p.arquivo, '', p.tipo, '', '', p.proporcao, ''].map(csv).join(';'))
    // BOM: o Excel abre com os acentos certos.
    await fs.writeFile(path.join(m.pasta, 'indice.csv'), '﻿' + linhas.join('\r\n') + '\r\n').catch((err) => this.log('frames: não consegui gravar o índice:', err?.message))
  }

  // ── o trabalho

  view(job = this.job) {
    if (!job) return null
    return { jobId: job.id, status: job.status, fase: job.fase, frac: job.frac, texto: job.texto, video: job.videoNome, manifestoId: job.manifestoId, ...(job.erro ? { erro: job.erro } : {}) }
  }

  #fase(job, fase, frac, texto) {
    Object.assign(job, { fase, frac, texto })
    const now = Date.now()
    if (now - (job.enviado || 0) < 200 && frac != null && frac < 1) return
    job.enviado = now
    this.onChange(this.view(job))
  }

  /**
   * Começa um trabalho. `origem`: { tipo: 'local', caminho } ou { tipo: 'drive', accountId, fileId }.
   * `ajustes`: { frames: { quantidade, formato, logo }, takes: { quantidade, duracao, formato, foco, audio, fade, codec,
   *   logo } | null, logo: { path, posicao, tamanho, opacidade } | null, destino: pasta local | null,
   *   subir: { accountId, folderId, driveId, name } | 'junto' | null }
   */
  iniciar({ origem, ajustes }) {
    if (this.job?.status === 'running') throw new FramesError('Já estou fazendo os frames de um vídeo. Espere terminar ou pare.', 409)
    const job = { id: newId('frm_'), status: 'running', fase: 'preparando', frac: 0, texto: 'Preparando…', videoNome: null, manifestoId: null, erro: null, ac: new AbortController() }
    this.job = job
    this.onChange(this.view(job))
    job.fim = this.#rodar(job, origem, ajustes).then(
      () => {
        job.status = 'done'
        this.onChange(this.view(job))
      },
      (err) => {
        if (job.ac.signal.aborted) {
          job.status = 'canceled'
          job.erro = 'Parado. O que já ficou pronto continua na pasta.'
        } else {
          job.status = 'error'
          job.erro = err?.status ? err.message : `Não terminei: ${err?.message || 'algo deu errado no caminho.'}`
          this.log('frames falhou:', err?.stack || err)
        }
        this.onChange(this.view(job))
      },
    )
    return job.id
  }

  /** Espera o trabalho terminar (pronto, parado ou com erro). Devolve a visão final dele. */
  async esperar(jobId) {
    const job = this.job?.id === jobId ? this.job : null
    if (!job) return null
    await job.fim
    return this.view(job)
  }

  cancelar(jobId) {
    if (this.job?.id !== jobId) return false
    this.job.ac.abort()
    return true
  }

  close() {
    this.job?.ac.abort()
  }

  async #rodar(job, origem, aj) {
    const signal = job.ac.signal
    const motor = await this.motor()
    const ffmpeg = motor?.ffmpeg?.path
    if (!ffmpeg) throw new FramesError('Este computador ainda não tem o conversor de vídeo (ffmpeg). Veja em Ajustes → Proxy.', 409)
    const encoder = motor.encoder?.nome || 'libx264'

    let videoPath = origem.caminho
    let limpar = async () => {}
    let video
    if (origem.tipo === 'drive') {
      const drive = this.drive(origem.accountId)
      const item = await drive.getItem(origem.fileId, { signal, media: true })
      if (item.isFolder) throw new FramesError('Escolha um arquivo de vídeo.')
      job.videoNome = item.name
      this.#fase(job, 'baixando', 0, 'Descendo o vídeo do Drive…')
      const b = await this.baixar(drive, item, { signal, onFase: (_f, frac) => this.#fase(job, 'baixando', frac, 'Descendo o vídeo do Drive…') })
      videoPath = b.path
      limpar = b.limpar
      video = { nome: item.name, origem: 'drive', accountId: origem.accountId, fileId: item.id, folderId: item.parents?.[0] ?? null, driveId: item.driveId ?? null }
    } else {
      job.videoNome = path.basename(videoPath)
      video = { nome: path.basename(videoPath), origem: 'local', caminho: videoPath }
    }

    try {
      this.#fase(job, 'lendo', 0, 'Assistindo o filme…')
      const info = await sondar(ffmpeg, videoPath, { signal })
      const a = await amostrar(ffmpeg, videoPath, { info, signal, onProgress: (f) => this.#fase(job, 'lendo', f, 'Assistindo o filme…') })
      const cs = separarCenas(a.amostras, a.passo)
      Object.assign(video, { duracaoS: info.durationS, largura: info.video.width, altura: info.video.height, fps: info.fps, codec: info.video.codec, audio: info.audio })

      const base = baseDoNome(video.nome)
      const raiz = aj.destino || this.pastaPadrao()
      await fs.mkdir(raiz, { recursive: true })
      const nomePasta = uniqueName(safeLocalName(`${video.nome.replace(/\.[^.]{1,6}$/, '')} — Frames e Takes`), await fs.readdir(raiz).catch(() => []))
      const pasta = path.join(raiz, nomePasta)
      await fs.mkdir(path.join(pasta, 'Frames'), { recursive: true })

      const m = {
        versao: 1,
        id: job.id,
        criado: new Date().toISOString(),
        video,
        pasta,
        base,
        ajustes: aj,
        cenas: [],
        frames: [],
        takes: [],
        posts: [],
        descartes: null,
        drive: null,
      }
      job.manifestoId = m.id
      await fs.mkdir(path.join(this.dirDe(m.id), 'mini'), { recursive: true })

      // Cenas: etiquetas automáticas e os candidatos (para "outro frame" e "mais um" sem ler o filme de novo).
      const ref = refPorCena(a.amostras, cs)
      const difs = a.amostras.map((x) => x.dif).sort((x, y) => x - y)
      const difNormal = Math.max(2, difs[Math.floor(difs.length / 2)] || 0)
      const margem = Math.ceil(0.35 / a.passo)
      m.cenas = cs.map((c) => {
        const cand = []
        for (let k = c.de + margem; k <= c.ate - margem; k++) {
          const s = a.amostras[k]
          const n = nota(s, ref[k], difNormal)
          if (n > 0) cand.push({ t: +(s.t + a.passo / 2).toFixed(3), nota: +n.toFixed(3), hash: s.hash })
        }
        cand.sort((x, y) => y.nota - x.nota)
        return { n: c.i + 1, ini: +c.ini.toFixed(3), fim: +c.fim.toFixed(3), tags: etiquetas(a.amostras, c), nome: null, candidatos: cand.slice(0, CANDIDATOS_POR_CENA) }
      })

      // Frames
      const esc = escolherFrames({ ...a, cenas: cs }, aj.frames.quantidade)
      m.descartes = esc.descartes
      const porCena = new Map()
      const fmt = aj.frames.formato
      const lista = esc.frames.map((f, i) => {
        const n = f.cena + 1
        const k = (porCena.get(n) || 0) + 1
        porCena.set(n, k)
        const tc = timecode(f.t, info.fps)
        return { id: `F${dd(i + 1, 3)}`, cena: n, t: +f.t.toFixed(3), tc, nota: +f.nota.toFixed(3), hash: a.amostras[f.amostra].hash, descartado: false }
      })
      let feitos = 0
      this.#fase(job, 'frames', 0, `Tirando ${lista.length} frames em alta…`)
      await pool(lista, PARALELO, async (f) => {
        f.arquivo = await this.#tirarFrame(m, ffmpeg, videoPath, f, fmt, signal)
        feitos++
        this.#fase(job, 'frames', feitos / lista.length, `Frames: ${feitos} de ${lista.length}`)
      })
      m.frames = lista
      await this.#salvar(m)

      // Takes
      if (aj.takes?.quantidade > 0) {
        const tk = escolherTakes({ ...a, cenas: cs }, { quantidade: aj.takes.quantidade, duracao: aj.takes.duracao })
        await fs.mkdir(path.join(pasta, 'Takes'), { recursive: true })
        for (const [i, t] of tk.entries()) {
          const take = { id: `T${dd(i + 1)}`, cena: t.cena + 1, ini: +t.ini.toFixed(3), dur: +t.dur.toFixed(3), tc: timecode(t.ini, info.fps), nota: +t.nota.toFixed(3), formato: aj.takes.formato, codec: aj.takes.codec, descartado: false }
          this.#fase(job, 'takes', i / tk.length, `Takes: ${i + 1} de ${tk.length}`)
          take.arquivo = await this.#gerarTake(m, { ffmpeg, encoder, videoPath, take, signal, onProgress: (p) => this.#fase(job, 'takes', (i + p) / tk.length, `Takes: ${i + 1} de ${tk.length}`) })
          m.takes.push(take)
          await this.#salvar(m)
        }
      }
      await this.#salvar(m)

      // Sobe
      if (aj.subir) await this.#subirPasta(m, aj.subir)
      this.#fase(job, 'pronto', 1, 'Pronto')
    } finally {
      await limpar()
    }
  }

  #pastaCena(m, n) {
    const c = m.cenas.find((x) => x.n === n)
    return path.join('Frames', pastaDaCena(n, c?.nome || c?.tags.join(', ')))
  }

  async #tirarFrame(m, ffmpeg, videoPath, f, fmt, signal) {
    const rel = path.join(this.#pastaCena(m, f.cena), `${m.base}_C${dd(f.cena)}_${f.id}_${f.tc}.${fmt === 'tiff' ? 'tif' : fmt}`)
    const destino = path.join(m.pasta, rel)
    await fs.mkdir(path.dirname(destino), { recursive: true })
    const logo = m.ajustes.frames.logo && m.ajustes.logo ? m.ajustes.logo : null
    await extrairFrame({ ffmpeg, video: videoPath, t: f.t, destino, formato: fmt, logo, signal })
    await miniatura({ ffmpeg, entrada: destino, destino: path.join(this.dirDe(m.id), 'mini', `${f.id}.jpg`), signal })
    return rel
  }

  async #gerarTake(m, { ffmpeg, encoder, videoPath, take, signal, onProgress }) {
    const aj = m.ajustes.takes
    const sufixo = take.formato === 'original' ? '' : `_${take.formato.replace(':', 'x')}`
    const ext = take.codec === 'prores' ? 'mov' : 'mp4'
    const rel = path.join('Takes', `${m.base}_C${dd(take.cena)}_${take.id}_${take.tc}${sufixo}.${ext}`)
    const destino = path.join(m.pasta, rel)
    const logo = aj.logo && m.ajustes.logo ? m.ajustes.logo : null
    await extrairTake({ ffmpeg, encoder, video: videoPath, ini: take.ini, dur: take.dur, destino, formato: take.formato, foco: aj.foco ?? 0.5, audio: aj.audio && m.video.audio, fade: aj.fade, codec: take.codec, logo, altura: m.video.altura || 1080, signal, onProgress })
    await miniatura({ ffmpeg, entrada: destino, destino: path.join(this.dirDe(m.id), 'mini', `${take.id}.jpg`), t: take.dur / 2, signal })
    return rel
  }

  async #subirPasta(m, alvo) {
    const dest =
      alvo === 'junto'
        ? m.video.origem === 'drive' && m.video.folderId
          ? { accountId: m.video.accountId, folderId: m.video.folderId, driveId: m.video.driveId, name: null }
          : null
        : alvo
    if (!dest?.accountId) return null
    const r = await this.subir({ accountId: dest.accountId, pasta: m.pasta, folderId: dest.folderId || 'root', driveId: dest.driveId || null, name: dest.name || null })
    m.drive = { accountId: dest.accountId, folderId: dest.folderId || 'root', driveId: dest.driveId || null, name: dest.name || null, em: new Date().toISOString(), arquivos: r?.count ?? null }
    await this.#salvar(m)
    return r
  }

  // ── edições (tela)

  /** Precisa do vídeo para tirar quadro novo: só quando ele está no computador (o do Drive foi baixado e apagado). */
  async #videoLocal(m) {
    if (m.video.origem === 'local' && (await existe(m.video.caminho))) return m.video.caminho
    return null
  }

  async #comVideo(m, fn) {
    const local = await this.#videoLocal(m)
    if (local) return fn(local)
    if (m.video.origem !== 'drive') throw new FramesError('Não achei o vídeo original neste computador. O disco está conectado?', 409)
    const drive = this.drive(m.video.accountId)
    const item = await drive.getItem(m.video.fileId, { media: true })
    const b = await this.baixar(drive, item, {})
    try {
      return await fn(b.path)
    } finally {
      await b.limpar()
    }
  }

  /** Próximo candidato da cena: bom, longe dos que já estão e diferente deles. */
  #proximo(m, n) {
    const c = m.cenas.find((x) => x.n === n)
    if (!c) throw new FramesError('Essa cena não existe.')
    const usados = m.frames.filter((f) => f.cena === n)
    const ativos = usados.filter((f) => !f.descartado)
    const livres = c.candidatos.filter((k) => usados.every((f) => Math.abs(f.t - k.t) > 0.4))
    // Primeiro o que é bem diferente dos que estão; num plano longo e parecido, o que é pelo menos um pouco diferente.
    for (const minimo of [HASH_IGUAL, 4, 0]) {
      const k = livres.find((x) => ativos.every((f) => !f.hash || distanciaHash(f.hash, x.hash) >= minimo))
      if (k) return k
    }
    return null
  }

  #novoId(m) {
    const max = m.frames.reduce((s, f) => Math.max(s, Number(f.id.slice(1)) || 0), 0)
    return `F${dd(max + 1, 3)}`
  }

  async #moverParaDescartados(m, rel) {
    const de = path.join(m.pasta, rel)
    const para = path.join(this.dirDe(m.id), 'descartados', path.basename(rel))
    await fs.mkdir(path.dirname(para), { recursive: true })
    await fs.rename(de, para).catch(async (err) => {
      if (err?.code === 'EXDEV') {
        await fs.copyFile(de, para)
        await fs.rm(de, { force: true })
      } else if (err?.code !== 'ENOENT') throw err
    })
  }

  async #voltarDosDescartados(m, rel) {
    const de = path.join(this.dirDe(m.id), 'descartados', path.basename(rel))
    const para = path.join(m.pasta, rel)
    await fs.mkdir(path.dirname(para), { recursive: true })
    await fs.rename(de, para).catch(async (err) => {
      if (err?.code !== 'EXDEV') throw new FramesError('Esse arquivo não está mais nos descartados.', 409)
      await fs.copyFile(de, para)
      await fs.rm(de, { force: true })
    })
  }

  descartar(id, itemId, descartado = true) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const it = m.frames.find((f) => f.id === itemId) || m.takes.find((t) => t.id === itemId)
      if (!it) throw new FramesError('Esse item não existe mais.', 404)
      if (!!it.descartado === descartado) return m
      if (descartado) await this.#moverParaDescartados(m, it.arquivo)
      else await this.#voltarDosDescartados(m, it.arquivo)
      it.descartado = descartado
      await this.#salvar(m)
      return m
    })
  }

  /** "Outro frame" (troca) ou "Mais um desta cena" (acrescenta). */
  maisUm(id, { cena, trocar = null }) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const velho = trocar ? m.frames.find((f) => f.id === trocar) : null
      if (trocar && !velho) throw new FramesError('Esse frame não existe mais.', 404)
      const n = velho ? velho.cena : cena
      const k = this.#proximo(m, n)
      if (!k) throw new FramesError('Essa cena não tem mais nenhum quadro bom que seja diferente dos que já estão.', 409)
      const motor = await this.motor()
      const f = { id: this.#novoId(m), cena: n, t: k.t, tc: timecode(k.t, m.video.fps || 25), nota: k.nota, hash: k.hash, descartado: false }
      await this.#comVideo(m, async (v) => {
        f.arquivo = await this.#tirarFrame(m, motor.ffmpeg.path, v, f, m.ajustes.frames.formato)
      })
      if (velho && !velho.descartado) {
        await this.#moverParaDescartados(m, velho.arquivo)
        velho.descartado = true
      }
      m.frames.push(f)
      m.frames.sort((x, y) => x.t - y.t)
      await this.#salvar(m)
      return m
    })
  }

  /** Um frame no tempo exato que a pessoa escolheu (o ponto da régua). */
  frameEm(id, t) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const dur = m.video.duracaoS || 0
      if (!(t >= 0 && t < dur)) throw new FramesError('Esse tempo está fora do vídeo.')
      const c = m.cenas.find((x) => t >= x.ini && t < x.fim) || m.cenas[m.cenas.length - 1]
      const motor = await this.motor()
      const f = { id: this.#novoId(m), cena: c.n, t: +t.toFixed(3), tc: timecode(t, m.video.fps || 25), nota: 0, hash: null, manual: true, descartado: false }
      await this.#comVideo(m, async (v) => {
        f.arquivo = await this.#tirarFrame(m, motor.ffmpeg.path, v, f, m.ajustes.frames.formato)
      })
      m.frames.push(f)
      m.frames.sort((x, y) => x.t - y.t)
      await this.#salvar(m)
      return m
    })
  }

  /** Nome da cena (vira a pasta dela): "Praia", "Entrevista", "Making of". Vazio volta para as etiquetas. */
  nomearCena(id, n, nome) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const c = m.cenas.find((x) => x.n === n)
      if (!c) throw new FramesError('Essa cena não existe.')
      const antes = this.#pastaCena(m, n)
      c.nome = String(nome || '').trim().slice(0, 60) || null
      const depois = this.#pastaCena(m, n)
      if (antes !== depois) {
        const de = path.join(m.pasta, antes)
        const para = path.join(m.pasta, depois)
        if (await existe(para)) throw new FramesError('Já existe uma pasta com esse nome.', 409)
        if (await existe(de)) await fs.rename(de, para)
        for (const f of m.frames.filter((x) => x.cena === n)) f.arquivo = path.join(depois, path.basename(f.arquivo))
      }
      await this.#salvar(m)
      return m
    })
  }

  /** Take num formato novo (mesmo trecho): "este em 9:16", "este em ProRes". */
  outroTake(id, takeId, { formato, codec }) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const base = m.takes.find((t) => t.id === takeId)
      if (!base) throw new FramesError('Esse take não existe mais.', 404)
      const motor = await this.motor()
      const max = m.takes.reduce((s, t) => Math.max(s, Number(t.id.slice(1)) || 0), 0)
      const take = { ...base, id: `T${dd(max + 1)}`, formato: formato || base.formato, codec: codec || base.codec, descartado: false }
      await this.#comVideo(m, async (v) => {
        take.arquivo = await this.#gerarTake(m, { ffmpeg: motor.ffmpeg.path, encoder: motor.encoder?.nome || 'libx264', videoPath: v, take })
      })
      m.takes.push(take)
      m.takes.sort((x, y) => x.ini - y.ini || x.id.localeCompare(y.id))
      await this.#salvar(m)
      return m
    })
  }

  /** Post montado na tela (PNG ou JPEG em alta) → Posts/. */
  salvarPost(id, { tipo, proporcao, ext, dados }) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      await fs.mkdir(path.join(m.pasta, 'Posts'), { recursive: true })
      const nome = uniqueName(`${m.base}_Post_${safeLocalName(tipo, 'win32')}_${proporcao.replace(':', 'x')}.${ext}`, await fs.readdir(path.join(m.pasta, 'Posts')).catch(() => []))
      const rel = path.join('Posts', nome)
      await fs.writeFile(path.join(m.pasta, rel), dados)
      m.posts.push({ arquivo: rel, tipo, proporcao, criado: new Date().toISOString() })
      await this.#salvar(m)
      return { m, arquivo: rel }
    })
  }

  apagarPost(id, arquivo) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const p = m.posts.find((x) => x.arquivo === arquivo)
      if (!p) throw new FramesError('Esse post não existe mais.', 404)
      await this.#moverParaDescartados(m, p.arquivo)
      m.posts = m.posts.filter((x) => x !== p)
      await this.#salvar(m)
      return m
    })
  }

  subirAgora(id, alvo) {
    return this.#emFila(async () => {
      const m = await this.manifesto(id)
      const r = await this.#subirPasta(m, alvo)
      if (!r) throw new FramesError('Escolha a pasta do Drive.')
      return { m, r }
    })
  }

  /** Caminho de um arquivo do trabalho (frame, take, post) ou da miniatura, sempre dentro das pastas dele. */
  async caminho(id, { rel = null, mini = null, alta = null }) {
    const m = await this.manifesto(id)
    if (alta) {
      // Para montar os posts na tela: o frame em JPEG ou PNG (o navegador não abre TIFF; esse vira um JPEG de cache).
      const f = m.frames.find((x) => x.id === alta)
      if (!f) throw new FramesError('Esse frame não existe mais.', 404)
      const orig = path.join(m.pasta, f.arquivo)
      if (!/\.tif$/i.test(f.arquivo)) return orig
      const jpg = path.join(this.dirDe(id), 'alta', `${f.id}.jpg`)
      if (!(await existe(jpg))) {
        await fs.mkdir(path.dirname(jpg), { recursive: true })
        const motor = await this.motor()
        await miniatura({ ffmpeg: motor.ffmpeg.path, entrada: orig, destino: jpg, largura: Math.min(4096, m.video.largura || 1920) })
      }
      return jpg
    }
    if (mini) {
      if (!/^[FT]\d{1,4}$/.test(mini)) throw new FramesError('Arquivo inválido.')
      return path.join(this.dirDe(id), 'mini', `${mini}.jpg`)
    }
    const conhecido = [...m.frames, ...m.takes, ...m.posts].some((x) => x.arquivo === rel)
    if (!conhecido) throw new FramesError('Esse arquivo não é deste trabalho.', 404)
    const p = path.resolve(m.pasta, rel)
    if (!p.startsWith(path.resolve(m.pasta) + path.sep)) throw new FramesError('Arquivo inválido.')
    return p
  }

  /** Para a tela: tudo menos os candidatos e as impressões digitais. */
  paraTela(m) {
    return {
      ...m,
      cenas: m.cenas.map(({ candidatos, ...c }) => ({ ...c, sobram: candidatos.length })),
      frames: m.frames.map(({ hash, ...f }) => f),
    }
  }
}
