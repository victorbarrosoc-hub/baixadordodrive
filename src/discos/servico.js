// Copiar entre discos (docs/DISCOS.md): cartão → SSD, SSD → SSD, para um ou mais destinos ao mesmo tempo, com MD5
// conferido, velocidade e tempo restante. Um trabalho por vez: planejar (comparar) → copiar → relatório.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { KeepAwake } from '../engine/power.js'
import { DiscosError, planejar } from './planejar.js'

const WORKER_URL = new URL('./worker.js', import.meta.url)
const JANELA_MS = 3000 // velocidade "agora": média dos últimos 3 s
const AVISO_MS = 250
const MAX_FALHAS = 500

const carimbo = (d = new Date()) => {
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`
}

export class DiscosService {
  /**
   * @param {{ onChange?: Function, keepAwake?: { setActive(on: boolean): void }, workerUrl?: URL, log?: Function }} o
   */
  constructor({ onChange = () => {}, keepAwake = null, workerUrl = WORKER_URL, log = null } = {}) {
    this.onChange = onChange
    this.keepAwake = keepAwake ?? new KeepAwake({ log })
    this.workerUrl = workerUrl
    this.log = log || (() => {})
    this.fase = 'parado' // parado | planejando | pronto | copiando | feito | erro | cancelado
    this.plano = null
    this.erro = null
    this.prog = null
    this.resultado = null
    this.ac = null
    this.worker = null
    this.ultimoAviso = 0
    this.timer = null
  }

  // ───── estado para a tela ─────

  view() {
    const p = this.plano
    return {
      fase: this.fase,
      erro: this.erro,
      plano: p ? { origem: p.origem, nome: p.nome, destinos: p.destinos, ignorados: p.ignorados.length, opcoes: p.opcoes || null } : null,
      progresso: this.prog ? this.#progressoView() : null,
      resultado: this.resultado,
    }
  }

  #progressoView() {
    const g = this.prog
    const agora = Date.now()
    while (g.amostras.length > 1 && agora - g.amostras[0].t > JANELA_MS) g.amostras.shift()
    const a = g.amostras
    const janela = a.length > 1 ? (a.at(-1).trabalho - a[0].trabalho) / ((a.at(-1).t - a[0].t) / 1000) : 0
    const decorrido = Math.max(0.001, ((g.fim || agora) - g.inicio) / 1000)
    const media = g.trabalho / decorrido
    const restanteTrab = Math.max(0, g.totalTrabalho - g.trabalho)
    // Tempo restante pela média ponderada (a velocidade "agora" oscila muito com arquivos pequenos).
    const ritmo = janela > 0 ? 0.5 * janela + 0.5 * media : media
    return {
      arquivos: g.arquivos,
      totalArquivos: g.totalArquivos,
      copiados: g.copiados,
      totalBytes: g.totalBytes,
      conferidos: g.conferidos,
      totalConferir: g.totalConferir,
      atual: g.atual,
      etapa: g.etapa,
      inicio: g.inicio,
      decorrido,
      velocidade: Math.round(janela),
      velocidadeMedia: Math.round(g.copiados / decorrido),
      restante: g.fim ? 0 : ritmo > 0 ? Math.round(restanteTrab / ritmo) : null,
      falhas: g.falhas.length,
    }
  }

  #mudou(forcar = false) {
    const agora = Date.now()
    if (!forcar && agora - this.ultimoAviso < AVISO_MS) {
      if (!this.timer) this.timer = setTimeout(() => ((this.timer = null), this.#mudou(true)), AVISO_MS)
      return
    }
    this.ultimoAviso = agora
    try {
      this.onChange(this.view())
    } catch {}
  }

  // ───── planejar ─────

  async planejar({ origem, destinos, nome }) {
    if (this.fase === 'copiando' || this.fase === 'planejando') throw new DiscosError(409, 'Já tem uma cópia em andamento.')
    this.ac?.abort()
    this.ac = new AbortController()
    this.fase = 'planejando'
    this.erro = null
    this.resultado = null
    this.prog = null
    this.plano = null
    this.#mudou(true)
    try {
      this.plano = await planejar({ origem, destinos, nome, signal: this.ac.signal })
      this.fase = 'pronto'
    } catch (err) {
      this.fase = 'erro'
      this.erro = err.message
      this.#mudou(true)
      throw err instanceof DiscosError ? err : new DiscosError(err.status || 500, err.message)
    }
    this.#mudou(true)
    return this.view()
  }

  /** Os arquivos do plano, para a lista da tela. `estado`: novo | igual | diferente; `destino`: índice. */
  itens({ estado = null, destino = 0, limite = 300, de = 0 } = {}) {
    if (!this.plano) return { itens: [], total: 0 }
    const lista = this.plano.itens.filter((it) => !estado || it.estados[destino] === estado)
    return { total: lista.length, itens: lista.slice(de, de + limite).map((it) => ({ relPath: it.relPath, size: it.size, estados: it.estados })) }
  }

  // ───── copiar ─────

  /**
   * @param {{ substituir?: boolean, conferir?: boolean, relatorio?: boolean }} o
   *   substituir: grava por cima dos que existem com outro tamanho; conferir: lê o destino de novo e compara o MD5;
   *   relatorio: grava "SOBEDESCE_copia_<data>.md5" em cada destino (formato do md5sum).
   */
  async iniciar({ substituir = false, conferir = true, relatorio = true } = {}) {
    if (this.fase === 'copiando') throw new DiscosError(409, 'Já está copiando.')
    if (!this.plano || this.fase !== 'pronto') throw new DiscosError(409, 'Compare as pastas antes de copiar.')
    const p = this.plano
    p.opcoes = { substituir, conferir, relatorio }
    const quer = (e) => e === 'novo' || (e === 'diferente' && substituir)
    const trabalho = p.itens
      .map((it) => ({ it, alvos: it.estados.map((e, i) => (quer(e) ? i : -1)).filter((i) => i >= 0) }))
      .filter((x) => x.alvos.length)
    // Espaço: o que vai para cada destino (substituir conta o tamanho inteiro, por segurança).
    for (let di = 0; di < p.destinos.length; di++) {
      const d = p.destinos[di]
      const precisa = trabalho.reduce((s, x) => s + (x.alvos.includes(di) ? x.it.size : 0), 0)
      if (d.livre != null && precisa > d.livre) {
        throw new DiscosError(507, `Não cabe em ${d.caminho}: precisa de ${(precisa / 1e9).toFixed(1)} GB e tem ${(d.livre / 1e9).toFixed(1)} GB livres.`)
      }
    }
    const totalBytes = trabalho.reduce((s, x) => s + x.it.size, 0)
    this.prog = {
      inicio: Date.now(),
      fim: null,
      arquivos: 0,
      totalArquivos: trabalho.length,
      copiados: 0,
      totalBytes,
      conferidos: 0,
      totalConferir: conferir ? totalBytes : 0,
      trabalho: 0,
      totalTrabalho: totalBytes * (conferir ? 2 : 1),
      amostras: [{ t: Date.now(), trabalho: 0 }],
      atual: null,
      etapa: 'copiando',
      falhas: [],
    }
    this.resultado = null
    this.erro = null
    this.fase = 'copiando'
    this.cancelado = false
    this.keepAwake?.setActive(true)
    this.#mudou(true)
    this.rodando = this.#rodar(trabalho, { conferir, relatorio }).catch((err) => this.log('discos', err))
    return this.view()
  }

  async #rodar(trabalho, { conferir, relatorio }) {
    const p = this.plano
    const g = this.prog
    const md5s = p.destinos.map(() => []) // por destino: [md5, relPath] dos que deram certo
    let fatal = null
    const w = new Worker(this.workerUrl)
    this.worker = w
    let espera = null
    w.on('message', (m) => {
      if (m.tipo === 'bytes') {
        g.copiados += m.copiando
        g.conferidos += m.conferindo
        g.trabalho += m.copiando + m.conferindo
        g.amostras.push({ t: Date.now(), trabalho: g.trabalho })
        if (g.amostras.length > 200) g.amostras.splice(0, 100)
        this.#mudou()
      } else if (m.tipo === 'feito' || m.tipo === 'erro') {
        espera?.ok(m)
      }
    })
    w.on('error', (err) => espera?.ok({ tipo: 'erro', erro: err.message }))
    w.on('exit', () => espera?.ok({ tipo: 'erro', erro: 'O processo de cópia parou.' }))
    const pedir = (msg) => new Promise((ok) => ((espera = { ok }), w.postMessage(msg)))

    let id = 0
    for (const { it, alvos } of trabalho) {
      if (this.cancelado || fatal) break
      g.atual = it.relPath
      g.etapa = 'copiando'
      this.#mudou()
      const antes = { copiados: g.copiados, conferidos: g.conferidos }
      const destinos = alvos.map((di) => path.join(p.destinos[di].pasta, ...it.relPath.split('/')))
      const r = await pedir({ tipo: 'copiar', id: ++id, origem: it.caminho, destinos, mtimeMs: it.mtimeMs, conferir })
      // Acerta a conta (arquivo que mudou de tamanho no meio, conferência que falhou): o progresso anda o tamanho certo.
      const corrigir = (campo, alvo) => {
        const delta = alvo - (g[campo] - antes[campo])
        g[campo] += delta
        g.trabalho += delta
      }
      if (r.tipo === 'erro') {
        if (r.cancelado) break
        if (r.codigo === 'ENOSPC') fatal = 'Um dos destinos encheu. A cópia parou.'
        if (g.falhas.length < MAX_FALHAS) g.falhas.push({ relPath: it.relPath, destino: null, erro: traduzir(r) })
        corrigir('copiados', it.size)
        if (conferir) corrigir('conferidos', it.size)
      } else {
        corrigir('copiados', it.size)
        if (conferir) corrigir('conferidos', it.size)
        r.destinos.forEach((d, k) => {
          const di = alvos[k]
          if (d.ok) md5s[di].push([r.md5, it.relPath])
          else {
            // Cópia que não bate com a origem não pode ficar com cara de pronta (a próxima comparação acharia "igual").
            fsp.rm(d.caminho, { force: true }).catch(() => {})
            if (g.falhas.length < MAX_FALHAS) g.falhas.push({ relPath: it.relPath, destino: p.destinos[di].caminho, erro: `${d.erro} A cópia ruim foi apagada; copie de novo.` })
          }
        })
      }
      g.arquivos++
      g.amostras.push({ t: Date.now(), trabalho: g.trabalho })
      this.#mudou()
    }

    if (this.cancelado) w.postMessage({ tipo: 'cancelar' })
    await w.terminate().catch(() => {})
    this.worker = null
    this.keepAwake?.setActive(false)
    g.fim = Date.now()
    g.atual = null

    const relatorios = []
    if (relatorio && !this.cancelado) {
      for (let di = 0; di < p.destinos.length; di++) {
        if (!md5s[di].length) continue
        const arq = path.join(p.destinos[di].pasta, `SOBEDESCE_copia_${carimbo()}.md5`)
        try {
          await fsp.mkdir(p.destinos[di].pasta, { recursive: true })
          await fsp.writeFile(arq, md5s[di].map(([m, r]) => `${m}  ${r}`).join('\n') + '\n')
          relatorios.push(arq)
        } catch (err) {
          this.log('discos: relatório', err.message)
        }
      }
    }
    const ok = md5s.reduce((s, l) => s + l.length, 0)
    this.resultado = {
      copiados: g.arquivos - new Set(g.falhas.map((f) => f.relPath)).size,
      gravacoes: ok,
      bytes: g.copiados,
      segundos: (g.fim - g.inicio) / 1000,
      conferido: conferir,
      falhas: g.falhas,
      relatorios,
      erro: fatal,
    }
    this.fase = this.cancelado ? 'cancelado' : fatal ? 'erro' : 'feito'
    this.erro = fatal
    // O que foi copiado agora está "igual" no destino: comparar de novo mostra a situação real.
    this.#mudou(true)
  }

  cancelar() {
    if (this.fase === 'planejando') {
      this.ac?.abort()
      return this.view()
    }
    if (this.fase !== 'copiando') return this.view()
    this.cancelado = true
    this.worker?.postMessage({ tipo: 'cancelar' })
    return this.view()
  }

  /** Volta para o começo (tela limpa). */
  limpar() {
    if (this.fase === 'copiando' || this.fase === 'planejando') throw new DiscosError(409, 'Pare a cópia antes.')
    this.fase = 'parado'
    this.plano = null
    this.prog = null
    this.resultado = null
    this.erro = null
    this.#mudou(true)
    return this.view()
  }

  async close() {
    this.cancelado = true
    this.ac?.abort()
    this.worker?.postMessage({ tipo: 'cancelar' })
    clearTimeout(this.timer)
    await this.rodando?.catch(() => {})
    this.keepAwake?.setActive(false)
  }
}

function traduzir(r) {
  const c = r.codigo
  if (c === 'ENOSPC') return 'Disco cheio.'
  if (c === 'EACCES' || c === 'EPERM') return 'Sem permissão para ler ou gravar.'
  if (c === 'ENOENT') return 'O arquivo sumiu (o disco foi desconectado?).'
  if (c === 'EIO') return 'Erro de leitura/gravação no disco (cabo, cartão ou SSD com problema).'
  if (c === 'EROFS') return 'O destino é somente leitura.'
  return r.erro || 'Não consegui copiar.'
}
