// Backup Automático (docs/BACKUP-AUTOMATICO.md): Cartões → Projetos. O projeto é configurado uma vez (destinos e diária);
// depois, cada cartão espetado é reconhecido e descarregado sozinho para
//   <destino>/<Projeto>/Diária NN/Cenas/<Dono - Câmera>/Cartão NN/<pastas do cartão>
// Na primeira vez que um cartão aparece, a tela pergunta de quem ele é (um toque). Depois: o id do volume, ou o número
// de série da câmera no XML da Sony (cartão formatado), já dizem o dono.
// A cópia é o motor do "Entre discos" (src/discos/), numa instância só daqui: compara por caminho e tamanho, copia o que
// é novo, confere o copiado lendo de volta (xxHash64) e compara tudo de novo no fim. Um cartão por vez (fila).
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DiscosService } from '../discos/servico.js'
import { nomeDePasta } from '../discos/planejar.js'
import { listarVolumes, ejetar as ejetarVolume } from './volumes.js'
import { lerCamera } from './camera.js'

const VIGIA_MS = 3000
const HISTORICO_MAX = 500
const PEQUENO = 32 * 1024 * 1024 // índice/XML da câmera que o cartão reescreve entre uma leva e outra
const LISTA_MAX = 30
export const ANTERIORES = '.sobedesce-anteriores'

export class BackupError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'BackupError'
    this.status = status
  }
}

const novoId = (p) => `${p}${crypto.randomBytes(6).toString('base64url')}`
const dois = (n) => String(n).padStart(2, '0')
const hojeLocal = (d = new Date()) => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms).unref?.())
const dentro = (pai, filho) => {
  const r = path.relative(pai, filho)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
const carimbo = (d = new Date()) => `${hojeLocal(d)}_${dois(d.getHours())}${dois(d.getMinutes())}${dois(d.getSeconds())}`

/** "Aladim - FX30" (ou só o nome, sem câmera). */
export const rotuloDono = (d) => [String(d?.nome || '').trim(), String(d?.camera || '').trim()].filter(Boolean).join(' - ') || 'Sem nome'
const mesmoModelo = (a, b) => !!a && !!b && String(a).replace(/\s+/g, '').toLowerCase() === String(b).replace(/\s+/g, '').toLowerCase()

async function eDiretorio(p) {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function livreEm(dir) {
  try {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Grava o JSON inteiro de uma vez (arquivo temporário + rename): uma queda no meio não deixa o arquivo pela metade. */
export async function gravarAtomico(arquivo, dados) {
  await fsp.mkdir(path.dirname(arquivo), { recursive: true })
  const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(dados, null, 1))
  await fsp.rename(tmp, arquivo)
}

function vazio() {
  return { versao: 1, atual: null, ligado: false, projetos: [] }
}

function normalizarProjeto(p) {
  return {
    id: String(p.id),
    nome: String(p.nome || 'Projeto'),
    destinos: Array.isArray(p.destinos) ? p.destinos.filter((d) => typeof d === 'string') : [],
    ejetar: p.ejetar === true,
    criadoEm: p.criadoEm || new Date().toISOString(),
    diarias: Array.isArray(p.diarias) && p.diarias.length ? p.diarias : [{ n: 1, nome: 'Diária 01', criadaEm: new Date().toISOString() }],
    diaria: Number(p.diaria) || 1,
    donos: Array.isArray(p.donos) ? p.donos : [],
    cartoes: p.cartoes && typeof p.cartoes === 'object' ? p.cartoes : {},
    cameras: p.cameras && typeof p.cameras === 'object' ? p.cameras : {},
    ignorados: Array.isArray(p.ignorados) ? p.ignorados : [],
    rolos: p.rolos && typeof p.rolos === 'object' ? p.rolos : {},
    historico: Array.isArray(p.historico) ? p.historico.slice(0, HISTORICO_MAX) : [],
  }
}

function validarDestinos(destinos) {
  if (!Array.isArray(destinos)) throw new BackupError(400, 'Escolha pelo menos um destino.')
  const ds = destinos.filter((d) => typeof d === 'string' && d.trim()).map((d) => path.resolve(d.trim()))
  if (!ds.length) throw new BackupError(400, 'Escolha pelo menos um destino.')
  if (ds.length > 4) throw new BackupError(400, 'No máximo 4 destinos.')
  for (let i = 0; i < ds.length; i++) {
    for (let j = 0; j < ds.length; j++) {
      if (i !== j && dentro(ds[i], ds[j])) throw new BackupError(400, 'Um destino não pode ficar dentro do outro.')
    }
  }
  return ds
}

export class BackupService {
  /**
   * @param {{ arquivo: string, onChange?: Function, avisar?: (evento: string, dados: object) => void, log?: Function,
   *           listar?: () => Promise<object[]>, camera?: (raiz: string) => Promise<object>, ejetar?: (caminho: string) => Promise<boolean>,
   *           vigiaMs?: number, keepAwake?: object, workerUrl?: URL, agora?: () => Date }} o
   *   vigiaMs: 0 desliga o vigia automático (os testes chamam varrer()).
   */
  constructor({ arquivo, onChange = () => {}, avisar = () => {}, log = () => {}, listar = null, camera = lerCamera, ejetar = ejetarVolume, vigiaMs = VIGIA_MS, keepAwake, workerUrl, agora = () => new Date() } = {}) {
    this.arquivo = arquivo
    this.onChange = onChange
    this.avisar = avisar
    this.log = log
    this.cacheVolumes = new Map()
    this.listar = listar || (() => listarVolumes({ cache: this.cacheVolumes }))
    this.camera = camera
    this.ejetarFn = ejetar
    this.vigiaMs = vigiaMs
    this.agora = agora
    this.dados = vazio()
    this.vistos = new Map() // caminho → disco montado agora: { caminho, nome, id, capacidade, estado, donoId, ... }
    this.fila = [] // caminhos, na ordem em que entraram
    this.pedidos = [] // "de quem é este cartão?"
    this.destinosAgora = [] // { caminho, conectado, livre } na última varredura
    this.job = null // a descarga de agora
    this.ultimo = null // a última descarga (resultado com a lista do que falta)
    this.rodando = false
    this.varrendo = false
    this.timer = null
    this.fechado = false
    this.gravando = Promise.resolve()
    this.motor = new DiscosService({ onChange: () => this.#mudou(), keepAwake, workerUrl, log })
    this.ultimoAviso = 0
    this.avisoTimer = null
  }

  async init() {
    try {
      if (!this.arquivo) throw new Error('sem arquivo')
      const j = JSON.parse(await fsp.readFile(this.arquivo, 'utf8'))
      this.dados = { versao: 1, atual: j.atual || null, ligado: j.ligado === true, projetos: Array.isArray(j.projetos) ? j.projetos.map(normalizarProjeto) : [] }
      if (!this.dados.projetos.some((p) => p.id === this.dados.atual)) this.dados.atual = this.dados.projetos[0]?.id || null
    } catch {
      this.dados = vazio()
    }
    if (this.dados.ligado && this.#projeto()) this.#vigiar()
    else this.dados.ligado = false
    return this.view()
  }

  // ───── estado para a tela ─────

  #projeto() {
    return this.dados.projetos.find((p) => p.id === this.dados.atual) || null
  }

  #diaria(p) {
    return p.diarias.find((d) => d.n === p.diaria) || p.diarias.at(-1)
  }

  view() {
    const p = this.#projeto()
    const hoje = hojeLocal(this.agora())
    let projeto = null
    if (p) {
      const d = this.#diaria(p)
      const daDiaria = p.historico.filter((h) => h.diaria === d.n)
      const ultimoDia = daDiaria[0]?.data || null
      const donos = p.donos.map((o) => {
        const hs = daDiaria.filter((h) => h.donoId === o.id)
        const rolos = p.rolos[`${d.n}|${o.id}`] || {}
        return {
          id: o.id,
          nome: o.nome,
          camera: o.camera,
          rotulo: rotuloDono(o),
          cartoes: Object.keys(rolos).length,
          descargas: hs.length,
          bytes: hs.reduce((s, h) => s + (h.bytes || 0), 0),
          arquivos: hs.reduce((s, h) => s + (h.copiados || 0), 0),
        }
      })
      projeto = {
        id: p.id,
        nome: p.nome,
        ejetar: p.ejetar,
        destinos: p.destinos.map((c) => {
          const agora = this.destinosAgora.find((x) => x.caminho === c)
          return { caminho: c, nome: path.basename(c) || c, conectado: agora ? agora.conectado : null, livre: agora?.livre ?? null }
        }),
        diaria: { n: d.n, nome: d.nome },
        diarias: p.diarias.map((x) => ({ n: x.n, nome: x.nome })),
        // A data mudou desde a última descarga desta diária: talvez seja hora de começar a próxima (só sugestão).
        sugerirNovaDiaria: !!ultimoDia && ultimoDia !== hoje,
        donos,
        historico: p.historico.slice(0, LISTA_MAX),
        ignorados: p.ignorados.length,
        pasta: path.join(nomeDePasta(p.nome) || 'Projeto', d.nome, 'Cenas'),
      }
    }
    const job = this.job
    return {
      ligado: this.dados.ligado,
      atual: this.dados.atual,
      projetos: this.dados.projetos.map((x) => ({ id: x.id, nome: x.nome, diaria: this.#diaria(x).nome, descargas: x.historico.length })),
      projeto,
      volumes: [...this.vistos.values()]
        .filter((v) => v.estado !== 'destino')
        .map((v) => ({ caminho: v.caminho, nome: v.nome, estado: v.estado, dono: v.dono || null, erro: v.erro || null })),
      pedidos: this.pedidos.map((x) => ({ ...x })),
      fila: this.fila.map((c) => this.vistos.get(c)).filter(Boolean).map((v) => ({ caminho: v.caminho, nome: v.nome, dono: v.dono || null })),
      job: job
        ? {
            caminho: job.caminho,
            nome: job.nome,
            dono: job.dono,
            pasta: job.pasta,
            fase: job.fase,
            faltando: job.faltando,
            tentativa: job.tentativa,
            inicio: job.inicio,
            plano: job.plano,
            progresso: this.motor.fase === 'copiando' ? this.motor.view().progresso : null,
          }
        : null,
      ultimo: this.ultimo,
    }
  }

  #mudou(forcar = false) {
    const agora = Date.now()
    if (!forcar && agora - this.ultimoAviso < 250) {
      if (!this.avisoTimer) this.avisoTimer = setTimeout(() => ((this.avisoTimer = null), this.#mudou(true)), 250)
      return
    }
    this.ultimoAviso = agora
    try {
      this.onChange(this.view())
    } catch {}
  }

  #salvar() {
    if (!this.arquivo) return this.gravando
    const copia = JSON.parse(JSON.stringify(this.dados))
    this.gravando = this.gravando.then(() => gravarAtomico(this.arquivo, copia)).catch((err) => this.log('backup: salvar', err?.message || err))
    return this.gravando
  }

  // ───── projetos ─────

  async criarProjeto({ nome, destinos, ejetar = false } = {}) {
    if (this.job) throw new BackupError(409, 'Espere a descarga de agora terminar.')
    const n = nomeDePasta(nome)
    if (!n) throw new BackupError(400, 'Dê um nome ao projeto.')
    const p = normalizarProjeto({ id: novoId('prj'), nome: n, destinos: validarDestinos(destinos), ejetar: ejetar === true })
    this.dados.projetos.unshift(p)
    this.dados.atual = p.id
    this.#reiniciarVistos()
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  async editarProjeto(id, { nome, destinos, ejetar } = {}) {
    const p = this.dados.projetos.find((x) => x.id === id)
    if (!p) throw new BackupError(404, 'Projeto não encontrado.')
    if (this.job && this.dados.atual === id && (nome !== undefined || destinos !== undefined)) throw new BackupError(409, 'Espere a descarga de agora terminar para mudar o nome ou os destinos.')
    if (nome !== undefined) {
      const n = nomeDePasta(nome)
      if (!n) throw new BackupError(400, 'Dê um nome ao projeto.')
      p.nome = n
    }
    if (destinos !== undefined) {
      p.destinos = validarDestinos(destinos)
      this.#reiniciarVistos()
    }
    if (ejetar !== undefined) p.ejetar = ejetar === true
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  async abrir(id) {
    if (!this.dados.projetos.some((x) => x.id === id)) throw new BackupError(404, 'Projeto não encontrado.')
    if (this.job && this.dados.atual !== id) throw new BackupError(409, 'Espere a descarga de agora terminar.')
    if (this.dados.atual !== id) {
      this.dados.atual = id
      this.#reiniciarVistos()
    }
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  /** Tira o projeto da lista (os arquivos nos destinos ficam onde estão). */
  async apagarProjeto(id) {
    if (this.job && this.dados.atual === id) throw new BackupError(409, 'Espere a descarga de agora terminar.')
    this.dados.projetos = this.dados.projetos.filter((x) => x.id !== id)
    if (this.dados.atual === id) {
      this.dados.atual = this.dados.projetos[0]?.id || null
      this.#reiniciarVistos()
      if (!this.dados.atual) this.#parar()
    }
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  async ligar(on) {
    if (on && !this.#projeto()) throw new BackupError(409, 'Crie um projeto antes.')
    this.dados.ligado = !!on
    if (on) this.#vigiar()
    else this.#parar()
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  async novaDiaria() {
    const p = this.#projeto()
    if (!p) throw new BackupError(409, 'Crie um projeto antes.')
    if (this.job) throw new BackupError(409, 'Espere a descarga de agora terminar.')
    const n = Math.max(...p.diarias.map((d) => d.n)) + 1
    p.diarias.push({ n, nome: `Diária ${dois(n)}`, criadaEm: this.agora().toISOString() })
    p.diaria = n
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  async escolherDiaria(n) {
    const p = this.#projeto()
    if (!p) throw new BackupError(409, 'Crie um projeto antes.')
    if (this.job) throw new BackupError(409, 'Espere a descarga de agora terminar.')
    if (!p.diarias.some((d) => d.n === Number(n))) throw new BackupError(404, 'Diária não encontrada.')
    p.diaria = Number(n)
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  /** Volta a perguntar pelos discos que a pessoa mandou ignorar. */
  async esquecerIgnorados() {
    const p = this.#projeto()
    if (!p) return this.view()
    p.ignorados = []
    this.#reiniciarVistos()
    await this.#salvar()
    this.#mudou(true)
    return this.view()
  }

  // ───── o vigia dos discos ─────

  #vigiar() {
    if (this.timer || this.fechado) return
    if (this.vigiaMs > 0) {
      this.timer = setInterval(() => this.varrer().catch((err) => this.log('backup: vigia', err?.message || err)), this.vigiaMs)
      this.timer.unref?.()
      this.varrer().catch(() => {})
    }
  }

  #parar() {
    clearInterval(this.timer)
    this.timer = null
    this.dados.ligado = false
    this.fila = []
    this.pedidos = []
    for (const c of [...this.vistos.keys()]) if (!this.job || this.job.caminho !== c) this.vistos.delete(c)
  }

  #reiniciarVistos() {
    this.fila = []
    this.pedidos = []
    for (const c of [...this.vistos.keys()]) if (!this.job || this.job.caminho !== c) this.vistos.delete(c)
  }

  /** Uma passada: o que entrou, o que saiu, os destinos conectados. Os testes chamam direto. */
  async varrer() {
    if (this.varrendo || this.fechado) return
    const p = this.#projeto()
    if (!p || !this.dados.ligado) return
    this.varrendo = true
    try {
      this.destinosAgora = await Promise.all(p.destinos.map(async (c) => {
        const conectado = await eDiretorio(c)
        return { caminho: c, conectado, livre: conectado ? await livreEm(c) : null }
      }))
      const lista = (await this.listar()) || []
      const agora = new Set(lista.map((v) => v.caminho))
      for (const [c, v] of [...this.vistos]) if (!agora.has(c)) this.#saiu(v)
      for (const v of lista) if (!this.vistos.has(v.caminho)) await this.#chegou(v, p)
    } finally {
      this.varrendo = false
    }
    this.#processar()
    this.#mudou()
  }

  async #chegou(v, p) {
    const reg = { caminho: v.caminho, nome: v.nome || path.basename(v.caminho) || v.caminho, id: String(v.id || ''), capacidade: v.capacidade ?? null, estado: 'lendo' }
    this.vistos.set(v.caminho, reg)
    // O HD de destino (ou um disco que contém um destino) não é cartão.
    if (p.destinos.some((d) => dentro(v.caminho, d))) {
      reg.estado = 'destino'
      return
    }
    if (p.ignorados.includes(reg.id)) {
      reg.estado = 'ignorado'
      return
    }
    let donoId = p.cartoes[reg.id]?.donoId
    if (donoId && !p.donos.some((d) => d.id === donoId)) donoId = null
    let camera = null
    if (!donoId) {
      camera = await this.camera(v.caminho).catch(() => null)
      const peloSerial = camera?.serial ? p.cameras[camera.serial] : null
      if (peloSerial && p.donos.some((d) => d.id === peloSerial)) donoId = peloSerial
    }
    if (donoId) {
      this.#mapear(p, reg, donoId, camera)
      this.#enfileirar(reg)
      await this.#salvar()
      return
    }
    reg.estado = 'pedido'
    const mesmos = camera?.curto ? p.donos.filter((d) => mesmoModelo(d.camera, camera.curto)) : []
    const pedido = {
      caminho: reg.caminho,
      nome: reg.nome,
      volId: reg.id,
      capacidade: reg.capacidade,
      camera: camera ? { marca: camera.marca || null, modelo: camera.modelo || null, curto: camera.curto || null, serial: camera.serial || null } : null,
      donoSugerido: mesmos.length === 1 ? mesmos[0].id : null,
    }
    this.pedidos.push(pedido)
    try {
      this.avisar('backup-pedido', { nome: reg.nome, camera: pedido.camera?.curto || null })
    } catch {}
  }

  #mapear(p, reg, donoId, camera) {
    p.cartoes[reg.id] = { donoId, rotulo: reg.nome, visto: this.agora().toISOString() }
    if (camera?.serial) p.cameras[camera.serial] = donoId
    const dono = p.donos.find((d) => d.id === donoId)
    reg.donoId = donoId
    reg.dono = rotuloDono(dono)
  }

  #enfileirar(reg) {
    reg.estado = 'fila'
    reg.erro = null
    if (!this.fila.includes(reg.caminho)) this.fila.push(reg.caminho)
  }

  #saiu(v) {
    this.vistos.delete(v.caminho)
    this.fila = this.fila.filter((c) => c !== v.caminho)
    this.pedidos = this.pedidos.filter((x) => x.caminho !== v.caminho)
    if (this.job?.caminho === v.caminho) this.job.saiu = true
  }

  /** "De quem é este cartão?": um dono que já existe, um novo ("Aladim" + "FX30") ou ignorar o disco. */
  async responder({ caminho, donoId, nome, camera, ignorar = false } = {}) {
    const p = this.#projeto()
    if (!p) throw new BackupError(409, 'Crie um projeto antes.')
    const pedido = this.pedidos.find((x) => x.caminho === caminho)
    const reg = this.vistos.get(caminho)
    if (!pedido || !reg) throw new BackupError(404, 'Esse cartão não está mais esperando. Ele foi retirado?')
    this.pedidos = this.pedidos.filter((x) => x !== pedido)
    if (ignorar) {
      if (!p.ignorados.includes(reg.id)) p.ignorados.push(reg.id)
      reg.estado = 'ignorado'
    } else {
      let dono = donoId ? p.donos.find((d) => d.id === donoId) : null
      if (!dono) {
        const n = String(nome || '').trim().slice(0, 60)
        const c = String(camera || '').trim().slice(0, 40)
        if (!n) {
          this.pedidos.unshift(pedido)
          throw new BackupError(400, 'Diga de quem é o cartão.')
        }
        dono = p.donos.find((d) => d.nome.toLowerCase() === n.toLowerCase() && String(d.camera || '').toLowerCase() === c.toLowerCase())
        if (!dono) {
          dono = { id: novoId('don'), nome: n, camera: c, criadoEm: this.agora().toISOString() }
          p.donos.push(dono)
        }
      }
      this.#mapear(p, reg, dono.id, pedido.camera)
      this.#enfileirar(reg)
    }
    await this.#salvar()
    this.#processar()
    this.#mudou(true)
    return this.view()
  }

  /** Descarrega de novo um cartão que ainda está espetado (depois de cancelar ou de um erro). */
  async repetir(caminho) {
    const reg = this.vistos.get(caminho)
    if (!reg || !reg.donoId) throw new BackupError(404, 'Esse cartão não está espetado.')
    if (this.job?.caminho === caminho || this.fila.includes(caminho)) return this.view()
    this.#enfileirar(reg)
    this.#processar()
    this.#mudou(true)
    return this.view()
  }

  async ejetar(caminho) {
    // Só um disco que o vigia viu (nada de ejetar um caminho qualquer que chegou pela rota).
    if (!this.vistos.has(caminho)) throw new BackupError(404, 'Esse cartão não está espetado.')
    if (this.job?.caminho === caminho) throw new BackupError(409, 'Espere a descarga deste cartão terminar.')
    const ok = await this.ejetarFn(caminho)
    if (!ok) throw new BackupError(409, 'O sistema não deixou ejetar agora. Feche o que estiver usando o cartão.')
    const reg = this.vistos.get(caminho)
    if (reg) reg.estado = 'ejetado'
    this.#mudou(true)
    return this.view()
  }

  cancelar() {
    if (!this.job) return this.view()
    this.job.cancelado = true
    this.motor.cancelar()
    this.#mudou(true)
    return this.view()
  }

  // ───── a descarga ─────

  #processar() {
    if (this.rodando || this.fechado) return
    while (this.fila.length && !this.vistos.get(this.fila[0])) this.fila.shift()
    const caminho = this.fila.shift()
    if (!caminho) return
    const reg = this.vistos.get(caminho)
    this.rodando = true
    this.#descarregar(reg)
      .catch((err) => this.log('backup: descarga', err?.message || err))
      .finally(() => {
        this.rodando = false
        this.job = null
        this.#mudou(true)
        this.#processar()
      })
  }

  #rolo(p, diaria, donoId, volId) {
    const k = `${diaria}|${donoId}`
    const r = (p.rolos[k] ||= {})
    if (!r[volId]) r[volId] = Math.max(0, ...Object.values(r)) + 1
    return r[volId]
  }

  /** Arquivos com o mesmo nome e outro tamanho: o pequeno e mais novo no cartão é o índice da câmera reescrito; o
   *  antigo vai para .sobedesce-anteriores e o novo é copiado. O resto fica como alerta (nunca por cima). */
  async #guardarAntigos(plano) {
    let movidos = 0
    for (const it of plano.itens) {
      if (it.size > PEQUENO) continue
      for (let di = 0; di < plano.destinos.length; di++) {
        if (it.estados[di] !== 'diferente') continue
        const alvo = path.join(plano.destinos[di].pasta, ...it.relPath.split('/'))
        try {
          const st = await fsp.stat(alvo)
          if (!st.isFile() || st.size > PEQUENO || !(it.mtimeMs > st.mtimeMs)) continue
          const guarda = path.join(plano.destinos[di].pasta, ANTERIORES, carimbo(this.agora()), ...it.relPath.split('/'))
          await fsp.mkdir(path.dirname(guarda), { recursive: true })
          await fsp.rename(alvo, guarda)
          movidos++
        } catch (err) {
          this.log('backup: guardar anterior', err?.message || err)
        }
      }
    }
    return movidos
  }

  async #descarregar(reg) {
    const p = this.#projeto()
    const dono = p?.donos.find((d) => d.id === reg.donoId)
    if (!p || !dono) return
    const diaria = this.#diaria(p)
    const job = (this.job = { caminho: reg.caminho, nome: reg.nome, volId: reg.id, donoId: dono.id, dono: rotuloDono(dono), fase: 'esperando', faltando: [], tentativa: 0, inicio: Date.now(), plano: null, pasta: null })
    reg.estado = 'copiando'
    this.#mudou(true)

    // Destino desconectado: espera ele voltar (o vigia continua de olho no cartão).
    for (;;) {
      const faltam = []
      for (const d of p.destinos) if (!(await eDiretorio(d))) faltam.push(path.basename(d) || d)
      if (!faltam.length) break
      job.fase = 'esperando-destino'
      job.faltando = faltam
      this.#mudou()
      await dormir(Math.max(200, this.vigiaMs || 500))
      if (job.saiu || job.cancelado || this.fechado || !this.dados.ligado || this.#projeto() !== p) {
        reg.estado = job.cancelado ? 'cancelado' : 'fila'
        if (!job.saiu && !job.cancelado && this.dados.ligado) this.fila.unshift(reg.caminho)
        return
      }
    }
    job.faltando = []

    const n = this.#rolo(p, diaria.n, dono.id, reg.id)
    const pasta = `Cartão ${dois(n)}`
    const pais = p.destinos.map((d) => path.join(d, nomeDePasta(p.nome) || 'Projeto', diaria.nome, 'Cenas', nomeDePasta(rotuloDono(dono)) || 'Sem nome'))
    job.pasta = [diaria.nome, 'Cenas', rotuloDono(dono), pasta].join(' / ')
    await this.#salvar()

    let copiados = 0
    let bytes = 0
    let erro = null
    const planejar = async () => {
      job.fase = 'comparando'
      this.#mudou(true)
      await this.motor.planejar({ origem: reg.caminho, destinos: pais, nome: pasta })
      if (!this.motor.plano) throw new BackupError(499, 'Cancelado.') // parou no meio da comparação
      const it = this.motor.plano.itens
      job.plano = {
        arquivos: it.length,
        bytes: this.motor.plano.origem.bytes,
        novos: it.filter((x) => x.estados.includes('novo')).length,
        iguais: it.filter((x) => x.estados.every((e) => e === 'igual')).length,
        diferentes: it.filter((x) => x.estados.includes('diferente')).length,
      }
    }
    try {
      for (const pai of pais) await fsp.mkdir(pai, { recursive: true })
      await planejar()
      if (await this.#guardarAntigos(this.motor.plano)) await planejar()
      // Copia o que é novo; depois compara de novo (o comparativo automático). Sobrou algo (falha)? Mais uma vez.
      while (job.plano.novos && job.tentativa < 2 && !job.cancelado && !job.saiu) {
        job.tentativa++
        job.fase = 'copiando'
        await this.motor.iniciar({ substituir: false, conferir: true, conferirIguais: false, relatorio: true, algoritmo: 'xxh64' })
        await this.motor.rodando
        const r = this.motor.resultado
        if (r) {
          copiados += r.copiados || 0
          bytes += r.bytes || 0
          if (r.erro) erro = r.erro
        }
        if (job.cancelado || job.saiu || this.motor.fase === 'cancelado') break
        await planejar()
      }
    } catch (err) {
      const sumiu = job.saiu || !(await eDiretorio(reg.caminho))
      if (!job.cancelado) erro = sumiu ? 'O cartão saiu antes de terminar. Espete de novo: continua de onde parou.' : err?.message || 'A descarga parou.'
    }
    if (job.saiu && !erro) erro = 'O cartão saiu antes de terminar. Espete de novo: continua de onde parou.'

    const plano = this.motor.plano
    const itens = plano?.itens || []
    const faltam = itens.filter((it) => it.estados.includes('novo')).map((it) => it.relPath)
    const alertas = itens.filter((it) => it.estados.includes('diferente')).map((it) => it.relPath)
    const resultado = job.cancelado ? 'cancelado' : erro ? 'erro' : faltam.length || alertas.length ? 'falta' : 'ok'
    const agora = this.agora()
    const entrada = {
      id: novoId('dsc'),
      quando: agora.toISOString(),
      data: hojeLocal(agora),
      diaria: diaria.n,
      donoId: dono.id,
      dono: rotuloDono(dono),
      volId: reg.id,
      cartao: reg.nome,
      pasta: job.pasta,
      arquivos: itens.length,
      bytesCartao: plano?.origem?.bytes || 0,
      copiados,
      bytes,
      segundos: Math.round((Date.now() - job.inicio) / 1000),
      resultado,
      faltam: faltam.length,
      alertas: alertas.length,
      erro,
    }
    p.historico.unshift(entrada)
    if (p.historico.length > HISTORICO_MAX) p.historico.length = HISTORICO_MAX
    await this.#salvar()
    this.ultimo = { ...entrada, listaFaltam: faltam.slice(0, LISTA_MAX), listaAlertas: alertas.slice(0, LISTA_MAX), destinos: p.destinos.map((d) => path.basename(d) || d) }
    const ainda = this.vistos.get(reg.caminho)
    if (ainda) {
      ainda.estado = resultado
      ainda.erro = erro
    }
    try {
      this.avisar('backup-feito', { ok: resultado === 'ok', resultado, dono: entrada.dono, cartao: reg.nome, copiados, bytes, faltam: faltam.length, erro })
    } catch {}
    if (resultado === 'ok' && p.ejetar && ainda) {
      const ok = await this.ejetarFn(reg.caminho).catch(() => false)
      if (ok) ainda.estado = 'ejetado'
    }
  }

  async close() {
    this.fechado = true
    clearInterval(this.timer)
    clearTimeout(this.avisoTimer)
    this.timer = null
    if (this.job) this.job.cancelado = true
    await this.motor.close()
    await this.gravando
  }
}
