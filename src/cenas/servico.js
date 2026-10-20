// Busca por cena (docs/CENAS.md): "noiva com o buquê", "DJ", "criança entrando na cerimônia"… nos vídeos de uma
// pasta do Drive, sem etiquetar nada antes. Tudo roda neste computador: o vídeo não vai para nenhum serviço de IA.
//
//   Analisar a pasta ──▶ fila (um vídeo por vez)
//     modelo (baixa na primeira vez, arquivos.js) ──▶ proxy do Drive, se houver (bem mais leve), ou o original
//     ──▶ amostras a cada 2 s, só quadros-chave (amostrar.js) ──▶ vetores (modelo.js) ──▶ trechos (indice.js)
//     ──▶ <dados>/cenas/indices/<conta>_<arquivo>.json + miniaturas em <dados>/cenas/minis/<conta>_<arquivo>/<n>.jpg
//   Procurar ──▶ texto vira vetor ──▶ compara com todos os trechos dos vídeos analisados ──▶ os melhores
//   Salvar trecho ──▶ ffmpeg corta do original no Drive (sem recodificar) para Downloads/Cenas
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ArquivosModelo } from './arquivos.js'
import { Modelo, carregarOrt } from './modelo.js'
import { amostrarPonto, amostrarSeguido, entradaArgs } from './amostrar.js'
import { buscar, desempacotar, empacotar, trechos as fazerTrechos } from './indice.js'
import { abrirPonte } from './ponte.js'
import { PERFIS, cube, ehPerfil } from '../cor/lut.js'
import { PEDACO, pareceLog, perfilDosBytes } from '../cor/detectar.js'

export const PASSO = 2 // segundos entre amostras
const LOTE = 16 // imagens por vez no modelo
const SEGUIDO_ATE = 6e9 // até isso, lê o vídeo inteiro numa passada; acima, pula de ponto em ponto
const MAX_PONTOS = 600
const VIDEO = /\.(mp4|mov|m4v|mxf|mkv|avi|mts|m2ts|ts|mpg|mpeg|webm|wmv|3gp|dv)$/i
const MAX_TRECHO_SALVO = 10 * 60

export class CenasError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'CenasError'
    this.status = status
  }
}

const seguro = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 120)
const chaveDe = (accountId, fileId) => `${seguro(accountId)}_${seguro(fileId)}`
const versaoDe = (item) => item.md5Checksum || `${item.size || 0}-${item.modifiedTime || ''}`
const ehVideo = (it) => !it.isFolder && !it.isShortcut && (VIDEO.test(it.name || '') || /^video\//.test(it.mimeType || ''))
const ehProxy = (it) => it?.appProperties?.sobedesce === 'previa' || /(^|\/)prox(y|ies)\//i.test(it.relPath || '')

/** O suficiente de um DriveItem para a prévia abrir o vídeo (sem perguntar ao Drive de novo). */
const itemDe = (a) => ({ id: a.id, name: a.nome, size: a.size, mimeType: a.mimeType || 'video/mp4', parents: a.parents || [], driveId: a.driveId || null, video: a.video || null, isFolder: false })

export class CenasService {
  /**
   * @param {object} o
   * @param {string} o.dataRoot <dados>
   * @param {(accountId: string) => object} o.drive DriveClient da conta
   * @param {() => Promise<{ ffmpeg?: { path: string } }>} o.motor
   * @param {(drive, o) => Promise<{ proxy: object|null }>} [o.procurarProxy]
   * @param {() => string} [o.pastaTrechos] onde salvar os trechos
   * @param {(view) => void} [o.onChange]
   * Trocáveis nos testes: arquivos (ArquivosModelo), modelo (Modelo), ort.
   */
  constructor({ dataRoot, drive, motor, procurarProxy = async () => ({ proxy: null }), pastaTrechos, onChange = () => {}, log = () => {}, arquivos, modelo, ort, seguidoAte = SEGUIDO_ATE } = {}) {
    this.dir = path.join(dataRoot, 'cenas')
    this.drive = drive
    this.motor = motor
    this.procurarProxy = procurarProxy
    this.pastaTrechos = pastaTrechos || (() => path.join(os.homedir(), 'Downloads', 'Cenas'))
    this.onChange = onChange
    this.log = log
    this.arquivos = arquivos || new ArquivosModelo({ dir: path.join(this.dir, 'modelo') })
    this.modelo = modelo || null
    this.ort = ort
    this.seguidoAte = seguidoAte
    this.fila = [] // { id, accountId, fileId, nome, fase: 'na_fila'|'lendo'|'pronto'|'erro', frac, erro, item }
    this.rodando = null
    this.ac = null
    this.indices = new Map() // chave → índice desempacotado (memória)
    this.disponivel = null // null = ainda não sabe; false = sem onnxruntime neste computador
    this.timer = null
    this.closed = false
  }

  // ─────────── estado para a tela ───────────

  view() {
    const st = this.arquivos.status()
    return {
      disponivel: this.disponivel !== false,
      modelo: { pronto: this.modeloPronto === true, baixando: st.baixando, recebido: st.progresso?.recebido ?? 0, total: st.total, erro: st.erro },
      fila: this.fila.slice(-60).map(({ item, raiz, perfilPedido, ...f }) => f),
      analisando: this.fila.some((f) => f.fase === 'na_fila' || f.fase === 'lendo'),
    }
  }

  #mudou() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChange(this.view())
    }, 200)
    this.timer.unref?.()
  }

  async init() {
    this.modeloPronto = await this.arquivos.prontos().catch(() => false)
    this.disponivel = (await (this.ort ? Promise.resolve(this.ort) : carregarOrt())) ? true : false
    return this.view()
  }

  // ─────────── modelo ───────────

  async #modelo() {
    if (this.disponivel === false) throw new CenasError(409, 'A busca por cena não roda neste computador (precisa de um Mac com Apple Silicon ou Windows).')
    if (!(await this.arquivos.prontos())) {
      this.#mudou()
      await this.arquivos.baixar({ onProgress: () => this.#mudou() })
    }
    this.modeloPronto = true
    this.modelo ??= new Modelo({ arquivos: this.arquivos.caminhos(), ort: this.ort, threads: Math.max(1, os.cpus().length - 1) })
    await this.modelo.abrir()
    this.#mudou()
    return this.modelo
  }

  baixarModelo() {
    return this.#modelo().then(() => this.view())
  }

  // ─────────── fila ───────────

  /**
   * Põe na fila os vídeos de uma pasta (e das subpastas), menos proxies e os já analisados (mesma versão).
   * @returns {Promise<{ novos: number, prontos: number, total: number }>}
   */
  async analisarPasta({ accountId, folderId, perfil = 'auto', signal }) {
    if (perfil !== 'auto' && !ehPerfil(perfil)) throw new CenasError(400, 'Perfil de cor inválido.')
    if (this.disponivel === false) throw new CenasError(409, 'A busca por cena não roda neste computador (precisa de um Mac com Apple Silicon ou Windows).')
    const drive = this.drive(accountId)
    const { items } = await drive.walk(folderId, { signal, media: true, appProps: true })
    const videos = items.filter((it) => ehVideo(it) && !ehProxy(it))
    let novos = 0
    let prontos = 0
    for (const item of videos) {
      const ind = await this.#indice(accountId, item.id)
      // Mesma versão e mesmo jeito de ver a cor: já está analisado. Trocou o perfil escolhido: analisa de novo.
      if (ind && ind.arquivo?.versao === versaoDe(item) && (perfil === 'auto' || ind.arquivo?.perfil === perfil)) {
        prontos++
        continue
      }
      if (this.fila.some((f) => f.accountId === accountId && f.fileId === item.id && (f.fase === 'na_fila' || f.fase === 'lendo'))) continue
      this.fila.push({ id: crypto.randomUUID(), accountId, fileId: item.id, nome: item.name, pasta: item.relDir || '', raiz: folderId, perfilPedido: perfil, fase: 'na_fila', frac: 0, erro: null, item })
      novos++
    }
    this.#mudou()
    this.#girar()
    return { novos, prontos, total: videos.length }
  }

  parar() {
    for (const f of this.fila) if (f.fase === 'na_fila') Object.assign(f, { fase: 'erro', erro: 'Parado.' })
    this.ac?.abort()
    this.#mudou()
  }

  #girar() {
    if (this.rodando || this.closed) return
    const prox = this.fila.find((f) => f.fase === 'na_fila')
    if (!prox) return
    this.rodando = this.#analisar(prox)
      .catch((err) => {
        Object.assign(prox, { fase: 'erro', erro: err?.name === 'AbortError' ? 'Parado.' : err?.message || 'Não deu para analisar.' })
        if (err?.name !== 'AbortError') this.log('cenas:', prox.nome, err?.message)
      })
      .finally(() => {
        this.rodando = null
        this.ac = null
        this.#mudou()
        this.#girar()
      })
  }

  async #analisar(f) {
    this.ac = new AbortController()
    const signal = this.ac.signal
    Object.assign(f, { fase: 'lendo', frac: 0 })
    this.#mudou()
    const modelo = await this.#modelo()
    const ffmpeg = (await this.motor())?.ffmpeg?.path
    if (!ffmpeg) throw new CenasError(409, 'Sem o ffmpeg neste computador.')
    const drive = this.drive(f.accountId)
    const item = f.item
    const { proxy } = await this.procurarProxy(drive, { parentId: item.parents?.[0], name: item.name, driveId: item.driveId || null, excludeId: item.id, signal }).catch(() => ({ proxy: null }))
    const fonte = proxy && Number(proxy.size) > 0 ? proxy : item
    const duracao = (item.video?.durationMs || fonte.video?.durationMs || 0) / 1000 || null
    // Cor: LOG vira Rec.709 antes do modelo olhar (e as miniaturas já saem bonitas).
    const cor = f.perfilPedido && f.perfilPedido !== 'auto' ? { perfil: f.perfilPedido, origem: 'escolhido' } : await this.perfilDe({ accountId: f.accountId, fileId: item.id, ffmpeg, duracao, signal })
    f.perfil = cor.perfil
    const lut = await this.#lut(cor.perfil)
    const ponte = await abrirPonte(drive, fonte.id)
    const entrada = { url: ponte.url }
    const chave = chaveDe(f.accountId, item.id)
    // Temporário na mesma pasta dos dados: as miniaturas que ficam só mudam de lugar (sem copiar entre discos).
    await fsp.mkdir(path.join(this.dir, 'tmp'), { recursive: true })
    const tmp = await fsp.mkdtemp(path.join(this.dir, 'tmp', 'analise-'))
    try {
      const amostras = []
      let lote = []
      const esvaziar = async () => {
        if (!lote.length) return
        const vs = await modelo.imagens(lote.map((x) => x.rgb))
        lote.forEach((x, i) => amostras.push({ t: x.t, k: x.k, v: vs[i] }))
        lote = []
      }
      let passo = PASSO
      if (Number(fonte.size) <= this.seguidoAte || !duracao) {
        await amostrarSeguido({
          ffmpeg,
          entrada,
          passo,
          pastaMinis: tmp,
          signal,
          lut,
          onAmostra: async (rgb, k) => {
            lote.push({ rgb, t: k * passo, k })
            if (duracao) f.frac = Math.min(0.99, (k * passo) / duracao)
            if (lote.length >= LOTE) {
              await esvaziar()
              this.#mudou()
            }
          },
        })
      } else {
        // Original pesado sem proxy: pula de ponto em ponto (poucos ffmpeg ao mesmo tempo).
        passo = Math.max(PASSO, duracao / MAX_PONTOS)
        const pontos = Array.from({ length: Math.max(1, Math.floor(duracao / passo)) }, (_, k) => k)
        let feitos = 0
        const trabalhador = async () => {
          for (;;) {
            const k = pontos.shift()
            if (k == null || signal.aborted) return
            const rgb = await amostrarPonto({ ffmpeg, entrada, t: k * passo, miniatura: path.join(tmp, `${String(k + 1).padStart(6, '0')}.jpg`), signal, lut }).catch(() => null)
            if (rgb) lote.push({ rgb, t: k * passo, k })
            f.frac = Math.min(0.99, ++feitos / Math.max(1, Math.floor(duracao / passo)))
            if (lote.length >= LOTE) await esvaziar()
            this.#mudou()
          }
        }
        await Promise.all([trabalhador(), trabalhador(), trabalhador()])
        if (signal.aborted) throw Object.assign(new Error('parado'), { name: 'AbortError' })
      }
      await esvaziar()
      amostras.sort((a, b) => a.t - b.t)
      if (!amostras.length) throw new CenasError(422, 'Não consegui ler nenhum quadro deste vídeo.')
      const ts = fazerTrechos(amostras, passo)
      // Miniaturas: só a de cada trecho fica.
      const pastaMinis = path.join(this.dir, 'minis', chave)
      await fsp.rm(pastaMinis, { recursive: true, force: true })
      await fsp.mkdir(pastaMinis, { recursive: true })
      const porT = new Map(amostras.map((a) => [a.t, a.k]))
      for (const [i, tr] of ts.entries()) {
        const k = porT.get(tr.t)
        const de = path.join(tmp, `${String(k + 1).padStart(6, '0')}.jpg`)
        const para = path.join(pastaMinis, `${i}.jpg`)
        await fsp.rename(de, para).catch(() => fsp.copyFile(de, para).catch(() => {}))
      }
      const arquivo = {
        accountId: f.accountId,
        id: item.id,
        nome: item.name,
        pasta: f.pasta,
        parents: item.parents || [],
        raiz: f.raiz,
        versao: versaoDe(item),
        size: Number(item.size) || null,
        mimeType: item.mimeType || null,
        driveId: item.driveId || null,
        video: item.video || null,
        largura: item.video?.width || null,
        altura: item.video?.height || null,
        fonte: fonte === item ? 'original' : 'proxy',
        perfil: cor.perfil,
        perfilOrigem: cor.origem,
        analisadoEm: new Date().toISOString(),
      }
      const j = empacotar({ arquivo, origem: arquivo.fonte, duracao: duracao || amostras.at(-1).t + passo, passo, trechos: ts })
      await fsp.mkdir(path.join(this.dir, 'indices'), { recursive: true })
      const destino = path.join(this.dir, 'indices', `${chave}.json`)
      await fsp.writeFile(`${destino}.tmp`, JSON.stringify(j))
      await fsp.rename(`${destino}.tmp`, destino)
      this.indices.set(chave, desempacotar(j))
      Object.assign(f, { fase: 'pronto', frac: 1, trechos: ts.length, item: undefined })
    } finally {
      await ponte.fechar().catch(() => {})
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  // ─────────── índices ───────────

  async #indice(accountId, fileId) {
    const chave = chaveDe(accountId, fileId)
    if (this.indices.has(chave)) return this.indices.get(chave)
    const j = await fsp.readFile(path.join(this.dir, 'indices', `${chave}.json`), 'utf8').then(JSON.parse).catch(() => null)
    const ind = desempacotar(j)
    if (ind) this.indices.set(chave, ind)
    return ind
  }

  async #todosDaConta(accountId) {
    const nomes = await fsp.readdir(path.join(this.dir, 'indices')).catch(() => [])
    const pre = `${seguro(accountId)}_`
    const out = []
    for (const n of nomes) {
      if (!n.startsWith(pre) || !n.endsWith('.json')) continue
      const ind = await this.#indice(accountId, n.slice(pre.length, -5))
      if (ind && ind.arquivo?.accountId === accountId) out.push(ind)
    }
    return out
  }

  /** O que já foi analisado numa pasta (direto nela ou nas subpastas, pelo caminho guardado). */
  async pasta({ accountId, folderId }) {
    const todos = await this.#todosDaConta(accountId)
    const daPasta = todos.filter((i) => !folderId || i.arquivo.parents?.includes(folderId) || i.arquivo.raiz === folderId)
    return { videos: daPasta.map((i) => ({ fileId: i.arquivo.id, nome: i.arquivo.nome, trechos: i.trechos.length, duracao: i.duracao, fonte: i.arquivo.fonte, perfil: i.arquivo.perfil || 'rec709', analisadoEm: i.arquivo.analisadoEm })), total: todos.length }
  }

  /**
   * Procura `texto` nos vídeos analisados da conta (ou só nos `fileIds`).
   * @returns {Promise<{ resultados: object[], videos: number }>}
   */
  async procurar({ accountId, texto, fileIds = null, limite = 60 }) {
    const frase = String(texto || '').trim().slice(0, 200)
    if (!frase) return { resultados: [], videos: 0 }
    let indices = await this.#todosDaConta(accountId)
    if (fileIds?.length) indices = indices.filter((i) => fileIds.includes(i.arquivo.id))
    if (!indices.length) return { resultados: [], videos: 0 }
    const modelo = await this.#modelo()
    const q = await modelo.texto(frase)
    const rs = buscar(q, indices, { limite })
    return {
      videos: indices.length,
      resultados: rs.map((r) => ({ fileId: r.arquivo.id, nome: r.arquivo.nome, pasta: r.arquivo.pasta, perfil: r.arquivo.perfil || 'rec709', i: r.i, ini: r.ini, fim: r.fim, t: r.t, nota: r.nota, s: r.s, item: itemDe(r.arquivo) })),
    }
  }

  /** Caminho da miniatura de um trecho (para a rota servir). */
  async miniatura({ accountId, fileId, i }) {
    const n = Number(i)
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new CenasError(400, 'Miniatura inválida.')
    const p = path.join(this.dir, 'minis', chaveDe(accountId, fileId), `${n}.jpg`)
    if (!(await fsp.stat(p).catch(() => null))) throw new CenasError(404, 'Miniatura não encontrada.')
    return p
  }

  // ─────────── cor ───────────

  /** O .cube do perfil em <dados>/cenas/lut/ (gerado uma vez). Rec.709: sem LUT. */
  async #lut(perfil) {
    if (!perfil || !PERFIS[perfil]?.curva) return null
    const dir = path.join(this.dir, 'lut')
    const arq = path.join(dir, `${perfil}-v1.cube`)
    if (!(await fsp.stat(arq).catch(() => null))) {
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(`${arq}.tmp`, cube(perfil))
      await fsp.rename(`${arq}.tmp`, arq)
    }
    return arq
  }

  /**
   * O perfil de cor do vídeo: pelos metadados (começo e fim do arquivo original, pela ponte) e, sem eles, pela imagem
   * (3 quadros). Guarda na memória (a prévia pergunta de novo a cada abertura).
   * @returns {Promise<{ perfil: string, origem: 'metadados'|'imagem'|'padrao' }>}
   */
  async perfilDe({ accountId, fileId, ffmpeg = null, duracao = null, signal }) {
    const chave = `${accountId}\n${fileId}`
    if (this.perfis?.has(chave)) return this.perfis.get(chave)
    this.perfis ??= new Map()
    const drive = this.drive(accountId)
    const ponte = await abrirPonte(drive, fileId)
    let r = null
    try {
      // Um pedaço do arquivo. Falhou no meio (conexão caiu, servidor que ignora o Range)? Fica com o que veio: os
      // metadados são só uma dica, a imagem decide depois.
      const ler = async (range) => {
        const partes = []
        try {
          const res = await fetch(ponte.url, { headers: { range }, signal })
          if (!res.ok && res.status !== 206) return Buffer.alloc(0)
          const reader = res.body.getReader()
          let n = 0
          while (n < PEDACO) {
            const { done, value } = await reader.read()
            if (done) break
            partes.push(value)
            n += value.length
          }
          reader.cancel().catch(() => {})
        } catch (err) {
          if (signal?.aborted) throw err
        }
        return Buffer.concat(partes.map((p) => Buffer.from(p)))
      }
      const perfil = perfilDosBytes(Buffer.concat([await ler(`bytes=0-${PEDACO - 1}`), await ler(`bytes=-${PEDACO}`)]))
      if (perfil) r = { perfil, origem: 'metadados' }
      else if (ffmpeg) {
        const pontos = duracao ? [0.15, 0.5, 0.85].map((x) => x * duracao) : [1, 4, 8]
        const quadros = []
        for (const t of pontos) {
          const tmp = path.join(this.dir, 'tmp')
          await fsp.mkdir(tmp, { recursive: true })
          const mini = path.join(tmp, `perfil-${crypto.randomUUID()}.jpg`)
          const q = await amostrarPonto({ ffmpeg, entrada: { url: ponte.url }, t, miniatura: mini, signal }).catch(() => null)
          await fsp.rm(mini, { force: true }).catch(() => {})
          if (q) quadros.push(q)
        }
        if (pareceLog(quadros)) r = { perfil: 'log', origem: 'imagem' }
      }
    } finally {
      await ponte.fechar().catch(() => {})
    }
    // Cancelado no meio (a prévia fechou): não guarda um "Rec.709" que ninguém conferiu.
    if (signal?.aborted) throw new CenasError(499, 'Cancelado.')
    r ??= { perfil: 'rec709', origem: 'padrao' }
    if (r.origem !== 'padrao' || ffmpeg) this.perfis.set(chave, r)
    return r
  }

  async esquecer({ accountId, fileId = null }) {
    const alvos = fileId ? [chaveDe(accountId, fileId)] : (await this.#todosDaConta(accountId)).map((i) => chaveDe(accountId, i.arquivo.id))
    for (const c of alvos) {
      this.indices.delete(c)
      await fsp.rm(path.join(this.dir, 'indices', `${c}.json`), { force: true })
      await fsp.rm(path.join(this.dir, 'minis', c), { recursive: true, force: true })
    }
    this.#mudou()
    return { apagados: alvos.length }
  }

  /**
   * Salva o trecho do ORIGINAL (não do proxy) sem recodificar: o ffmpeg pula direto para o ponto pelo Drive.
   * O corte começa no quadro-chave anterior (sem recodificar não dá para cortar no meio de um GOP).
   */
  async salvarTrecho({ accountId, fileId, ini, fim, signal }) {
    const ind = await this.#indice(accountId, fileId)
    if (!ind) throw new CenasError(404, 'Este vídeo ainda não foi analisado.')
    const a = Math.max(0, Number(ini) || 0)
    const b = Math.min(ind.duracao || Infinity, Math.max(a + 1, Number(fim) || a + 5))
    if (b - a > MAX_TRECHO_SALVO) throw new CenasError(400, 'Trecho longo demais (até 10 minutos).')
    const ffmpeg = (await this.motor())?.ffmpeg?.path
    if (!ffmpeg) throw new CenasError(409, 'Sem o ffmpeg neste computador.')
    const drive = this.drive(accountId)
    const nome = ind.arquivo.nome || 'video.mp4'
    const ext = (path.extname(nome) || '.mp4').toLowerCase()
    // Mesmo contêiner do original (cópia sem recodificar); MXF e outros vão em .mov / .mkv, que aceitam o que vier.
    const saidaExt = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'].includes(ext) ? ext : ext === '.mxf' ? '.mov' : '.mkv'
    const tc = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60)].map((x) => String(x).padStart(2, '0')).join('-')
    const pasta = this.pastaTrechos()
    await fsp.mkdir(pasta, { recursive: true })
    const base = `${path.basename(nome, path.extname(nome)).replace(/[\\/:*?"<>|]/g, '_')}_${tc(a)}`
    let destino = path.join(pasta, `${base}${saidaExt}`)
    for (let n = 2; await fsp.stat(destino).catch(() => null); n++) destino = path.join(pasta, `${base} (${n})${saidaExt}`)
    const ponte = await abrirPonte(drive, fileId)
    const entrada = { url: ponte.url }
    const args = [...entradaArgs(entrada, { ss: a }), '-t', String(b - a), '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', destino]
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let erro = ''
      const parar = () => p.kill('SIGKILL')
      signal?.addEventListener('abort', parar, { once: true })
      p.stderr.on('data', (d) => {
        erro = (erro + d).slice(-1000)
      })
      p.on('error', reject)
      p.on('close', (code) => {
        signal?.removeEventListener('abort', parar)
        if (code === 0) resolve()
        else reject(new CenasError(502, `Não consegui cortar o trecho: ${erro.trim().split('\n').pop() || code}`))
      })
    })
      .catch(async (err) => {
        await fsp.rm(destino, { force: true }).catch(() => {})
        throw err
      })
      .finally(() => ponte.fechar().catch(() => {}))
    return { caminho: destino }
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    this.ac?.abort()
    await this.rodando?.catch(() => {})
    await this.modelo?.fechar()
  }
}
