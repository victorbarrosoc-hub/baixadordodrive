// Copiar entre discos (docs/DISCOS.md): cartão → SSD, SSD → SSD, para um ou mais destinos ao mesmo tempo, com checksum
// conferido (xxHash64 ou MD5), velocidade e tempo restante. Um trabalho por vez: planejar (comparar) → copiar → relatório.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { KeepAwake } from '../engine/power.js'
import { DiscosError, planejar } from './planejar.js'
import { ALGORITMOS } from './copiar.js'

const WORKER_URL = new URL('./worker.js', import.meta.url)
const JANELA_MS = 3000 // velocidade "agora": média dos últimos 3 s
const AVISO_MS = 250
const MAX_FALHAS = 500
const SIMULTANEOS = 24 // arquivos pequenos ao mesmo tempo (cada um com fsync: em paralelo o disco agrupa)
const GRANDE = 64 * 1024 * 1024 // daqui para cima, um por vez

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
      // Média do trabalho todo (copiar + conferir): só os bytes copiados dava 0 enquanto conferia o que já estava lá.
      velocidadeMedia: Math.round(g.trabalho / decorrido),
      // Conferindo o que já estava no destino (nada a copiar nesse arquivo).
      soConferindo: g.soConferindo,
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

  /** `procurarTudo`: o que não está no caminho esperado é procurado em qualquer pasta do destino (planejar.js). */
  async planejar({ origem, destinos, nome, procurarTudo = false }) {
    if (this.fase === 'copiando' || this.fase === 'planejando') throw new DiscosError(409, 'Já tem uma cópia em andamento.')
    this.ac?.abort()
    this.ac = new AbortController()
    this.fase = 'planejando'
    this.erro = null
    this.resultado = null
    this.prog = null
    this.plano = null
    this.#mudou(true)
    const ac = this.ac
    try {
      this.plano = await planejar({ origem, destinos, nome, procurarTudo, signal: ac.signal })
      this.fase = 'pronto'
    } catch (err) {
      // Cancelado na tela: não é erro, e o pedido de comparar termina normal (a tela mostra "cancelada").
      if (ac.signal.aborted) {
        this.fase = 'cancelado'
        this.plano = null
        this.erro = null
        this.#mudou(true)
        return this.view()
      }
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
    return {
      total: lista.length,
      itens: lista.slice(de, de + limite).map((it) => ({ relPath: it.relPath, size: it.size, estados: it.estados, achado: it.achados?.[destino] || null, para: it.para?.[destino] || null })),
    }
  }

  // ───── copiar ─────

  /**
   * @param {{ substituir?: boolean, conferir?: boolean, conferirIguais?: boolean, relatorio?: boolean, algoritmo?: string }} o
   *   substituir: grava por cima dos que existem com outro tamanho; conferir: lê o destino de novo e compara o checksum;
   *   conferirIguais: os que já estavam no destino (mesmo tamanho) também têm o checksum comparado; se não bater, são
   *   copiados de novo;
   *   relatorio: grava "SOBEDESCE_copia_<data>.xxh64" (ou .md5) em cada destino, no formato do xxhsum/md5sum;
   *   algoritmo: 'xxh64' (padrão, rápido) ou 'md5' (o mesmo checksum do Google Drive);
   *   juntar: os novos com vizinhos já em outra pasta do destino vão para essa pasta (planejar.js, `para`).
   */
  async iniciar({ substituir = false, conferir = true, conferirIguais = false, relatorio = true, algoritmo = 'xxh64', juntar = true } = {}) {
    if (!ALGORITMOS.includes(algoritmo)) throw new DiscosError(400, 'Checksum inválido.')
    if (this.fase === 'copiando') throw new DiscosError(409, 'Já está copiando.')
    if (!this.plano || this.fase !== 'pronto') throw new DiscosError(409, 'Compare as pastas antes de copiar.')
    const p = this.plano
    p.opcoes = { substituir, conferir, conferirIguais, relatorio, algoritmo, juntar }
    const quer = (e) => e === 'novo' || (e === 'diferente' && substituir)
    const indices = (fn) => (it) => it.estados.map((e, i) => (fn(e) ? i : -1)).filter((i) => i >= 0)
    const trabalho = p.itens
      .map((it) => ({ it, alvos: indices(quer)(it), checar: conferirIguais ? indices((e) => e === 'igual' || e === 'outro')(it) : [] }))
      .filter((x) => x.alvos.length || x.checar.length)
    // O que precisa ser copiado vai primeiro; conferir o que já estava lá (só leitura, opcional) fica para o fim.
    // Assim os arquivos novos chegam logo, mesmo com muito para conferir.
    trabalho.sort((a, b) => (b.alvos.length > 0) - (a.alvos.length > 0))
    // Espaço: o que vai para cada destino (substituir conta o tamanho inteiro, por segurança).
    for (let di = 0; di < p.destinos.length; di++) {
      const d = p.destinos[di]
      const precisa = trabalho.reduce((s, x) => s + (x.alvos.includes(di) ? x.it.size : 0), 0)
      if (d.livre != null && precisa > d.livre) {
        throw new DiscosError(507, `Não cabe em ${d.caminho}: precisa de ${(precisa / 1e9).toFixed(1)} GB e tem ${(d.livre / 1e9).toFixed(1)} GB livres.`)
      }
    }
    const totalBytes = trabalho.reduce((s, x) => s + (x.alvos.length ? x.it.size : 0), 0)
    const totalConferir = (conferir ? totalBytes : 0) + trabalho.reduce((s, x) => s + (x.checar.length ? x.it.size : 0), 0)
    this.prog = {
      inicio: Date.now(),
      fim: null,
      arquivos: 0,
      totalArquivos: trabalho.length,
      copiados: 0,
      totalBytes,
      conferidos: 0,
      totalConferir,
      trabalho: 0,
      totalTrabalho: totalBytes + totalConferir,
      jaConferidos: 0,
      corrigidos: 0,
      amostras: [{ t: Date.now(), trabalho: 0 }],
      atual: null,
      etapa: 'copiando',
      falhas: [],
      soConferindo: false,
    }
    this.resultado = null
    this.erro = null
    this.fase = 'copiando'
    this.cancelado = false
    this.keepAwake?.setActive(true)
    this.#mudou(true)
    this.rodando = this.#rodar(trabalho, { conferir, relatorio, algoritmo, juntar }).catch((err) => this.log('discos', err))
    return this.view()
  }

  async #rodar(trabalho, { conferir, relatorio, algoritmo, juntar }) {
    const p = this.plano
    const g = this.prog
    const hashes = p.destinos.map(() => []) // por destino: [hash, relPath] dos que deram certo
    const verificados = p.destinos.map(() => new Set()) // por destino: relPath com o checksum lido de volta e igual
    let fatal = null
    const w = new Worker(this.workerUrl)
    this.worker = w
    const esperando = new Map() // id → resolve
    const soltarTodos = (msg) => {
      for (const ok of esperando.values()) ok(msg)
      esperando.clear()
    }
    w.on('message', (m) => {
      if (m.tipo === 'bytes') {
        g.copiados += m.copiando
        g.conferidos += m.conferindo
        g.trabalho += m.copiando + m.conferindo
        g.amostras.push({ t: Date.now(), trabalho: g.trabalho })
        if (g.amostras.length > 200) g.amostras.splice(0, 100)
        this.#mudou()
      } else if (m.tipo === 'feito' || m.tipo === 'erro') {
        const ok = esperando.get(m.id)
        esperando.delete(m.id)
        ok?.(m)
      }
    })
    w.on('error', (err) => soltarTodos({ tipo: 'erro', erro: err.message }))
    w.on('exit', () => soltarTodos({ tipo: 'erro', erro: 'O processo de cópia parou.' }))
    let id = 0
    const pedir = (msg) => new Promise((ok) => (esperando.set(msg.id, ok), w.postMessage(msg)))

    // Vários arquivos pequenos ao mesmo tempo (fotos, áudio: o disco fica sempre ocupado); um grande por vez (leitura
    // sequencial, o que cartões e HDs preferem). Peso = vagas: um grande ocupa todas.
    let livres = SIMULTANEOS
    const filaVaga = []
    const pegarVaga = (peso) =>
      new Promise((ok) => {
        const tentar = () => (livres >= peso ? ((livres -= peso), ok(), true) : false)
        if (!filaVaga.length && tentar()) return
        filaVaga.push(tentar)
      })
    const soltarVaga = (peso) => {
      livres += peso
      while (filaVaga.length && filaVaga[0]()) filaVaga.shift()
    }

    // Os novos com vizinhos já em outra pasta do destino vão para lá (planejar.js, `para`), se `juntar`.
    const destinoDe = (di, it) => (juntar && it.para?.[di]) || path.join(p.destinos[di].pasta, ...it.relPath.split('/'))
    const foraDaPasta = (di, it) => !!(juntar && it.para?.[di])
    const juntados = p.destinos.map(() => new Set()) // por destino: gravados ao lado dos vizinhos (fora da pasta da cópia)
    // O que já existe: no caminho esperado, ou na outra pasta onde foi achado (estado 'outro').
    const existenteDe = (di, it) => (it.estados[di] === 'outro' && it.achados?.[di]) || destinoDe(di, it)
    // Acerta a conta de um arquivo (mudou de tamanho no meio, falhou, conferência parou): anda o tamanho certo.
    const acertar = (it, r, campo, fase) => {
      const delta = it.size - (r.contados?.[fase] || 0)
      g[campo] += delta
      g.trabalho += delta
    }
    const umArquivo = async ({ it, alvos: copiar, checar }) => {
      g.atual = it.relPath
      g.soConferindo = !copiar.length
      this.#mudou()
      const alvos = [...copiar]
      if (checar.length) {
        // Já estava no destino com o mesmo tamanho: compara o conteúdo. O que não bate entra na cópia (por cima).
        const c = await pedir({ tipo: 'comparar', id: ++id, origem: it.caminho, destinos: checar.map((di) => existenteDe(di, it)), tamanho: it.size, algoritmo })
        if (c.tipo === 'erro' && c.cancelado) return
        acertar(it, c, 'conferidos', 'conferindo')
        if (c.tipo === 'erro') {
          if (g.falhas.length < MAX_FALHAS) g.falhas.push({ relPath: it.relPath, destino: null, erro: traduzir(c) })
          g.arquivos++
          return
        }
        c.destinos.forEach((d, k) => {
          if (d.ok) {
            // O relatório fica na pasta da cópia: só entra o que está nela (o achado em outra pasta conta como conferido).
            if (it.estados[checar[k]] !== 'outro') hashes[checar[k]].push([c.hash, it.relPath])
            verificados[checar[k]].add(it.relPath)
            g.jaConferidos++
          } else {
            alvos.push(checar[k])
            g.corrigidos++
            g.totalBytes += it.size
            g.totalTrabalho += it.size * (conferir ? 2 : 1)
            if (conferir) g.totalConferir += it.size
          }
        })
        if (!alvos.length) {
          g.arquivos++
          this.#mudou()
          return
        }
      }
      const destinos = alvos.map((di) => destinoDe(di, it))
      const r = await pedir({ tipo: 'copiar', id: ++id, origem: it.caminho, destinos, tamanho: it.size, mtimeMs: it.mtimeMs, conferir, algoritmo })
      if (r.tipo === 'erro' && r.cancelado) return
      acertar(it, r, 'copiados', 'copiando')
      if (conferir) acertar(it, r, 'conferidos', 'conferindo')
      if (r.tipo === 'erro') {
        if (r.codigo === 'ENOSPC') fatal = 'Um dos destinos encheu. A cópia parou.'
        if (g.falhas.length < MAX_FALHAS) g.falhas.push({ relPath: it.relPath, destino: null, erro: traduzir(r) })
      } else {
        r.destinos.forEach((d, k) => {
          const di = alvos[k]
          if (d.ok) {
            // O relatório fica na pasta da cópia: o que foi para junto dos vizinhos conta na cobertura, fora do relatório.
            if (foraDaPasta(di, it)) juntados[di].add(it.relPath)
            else hashes[di].push([r.hash, it.relPath])
            if (conferir) verificados[di].add(it.relPath)
          } else {
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

    const rodando = new Set()
    for (const x of trabalho) {
      const peso = x.it.size >= GRANDE ? SIMULTANEOS : 1 // conferir um grande também lê muito: um por vez
      await pegarVaga(peso)
      if (this.cancelado || fatal) {
        soltarVaga(peso)
        break
      }
      const t = umArquivo(x).finally(() => (rodando.delete(t), soltarVaga(peso)))
      rodando.add(t)
    }
    await Promise.all(rodando)

    if (this.cancelado) w.postMessage({ tipo: 'cancelar' })
    await w.terminate().catch(() => {})
    this.worker = null
    this.keepAwake?.setActive(false)
    g.fim = Date.now()
    g.atual = null

    const relatorios = []
    if (relatorio && !this.cancelado) {
      for (let di = 0; di < p.destinos.length; di++) {
        if (!hashes[di].length) continue
        hashes[di].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        const arq = path.join(p.destinos[di].pasta, `SOBEDESCE_copia_${carimbo()}.${algoritmo}`)
        try {
          await fsp.mkdir(p.destinos[di].pasta, { recursive: true })
          await fsp.writeFile(arq, hashes[di].map(([h, r]) => `${h}  ${r}`).join('\n') + '\n')
          relatorios.push(arq)
        } catch (err) {
          this.log('discos: relatório', err.message)
        }
      }
    }
    const ok = hashes.reduce((s, l) => s + l.length, 0)
    // Cobertura: quantos arquivos da origem estão em cada destino agora (gravados agora, ou que já estavam lá) e quantos
    // tiveram o conteúdo conferido pelo checksum.
    const cobertura = p.destinos.map((d, di) => {
      const gravados = new Set([...hashes[di].map(([, r]) => r), ...verificados[di], ...juntados[di]])
      const ruins = new Set(g.falhas.filter((f) => !f.destino || f.destino === d.caminho).map((f) => f.relPath))
      let presentes = 0
      let diferentes = 0 // ficaram com outro tamanho no destino (não marcou "Substituir os diferentes")
      for (const it of p.itens) {
        if (gravados.has(it.relPath) || ((it.estados[di] === 'igual' || it.estados[di] === 'outro') && !ruins.has(it.relPath))) presentes++
        else if (it.estados[di] === 'diferente' && !p.opcoes.substituir) diferentes++
      }
      return { caminho: d.caminho, total: p.itens.length, presentes, conferidos: verificados[di].size, diferentes }
    })
    this.resultado = {
      cobertura,
      jaConferidos: g.jaConferidos,
      corrigidos: g.corrigidos,
      copiados: g.arquivos - new Set(g.falhas.map((f) => f.relPath)).size,
      gravacoes: ok,
      bytes: g.copiados,
      segundos: (g.fim - g.inicio) / 1000,
      conferido: conferir,
      algoritmo,
      falhas: g.falhas,
      relatorios,
      erro: fatal,
    }
    this.fase = this.cancelado ? 'cancelado' : fatal ? 'erro' : 'feito'
    this.erro = fatal
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
  if (c === 'EFBIG') return 'O destino não aceita arquivos deste tamanho (FAT32 vai só até 4 GB): formate o disco em exFAT, APFS ou NTFS.'
  if (c === 'EINVAL' || c === 'ENAMETOOLONG') return 'O destino não aceita este nome de arquivo (caractere ou tamanho do nome).'
  if (c === 'ETIMEDOUT' || c === 'ENXIO' || c === 'ENODEV') return 'O disco parou de responder (desconectado ou dormindo).'
  return r.erro || 'Não consegui copiar.'
}
