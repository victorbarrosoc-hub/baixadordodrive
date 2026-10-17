// Motor de envio no navegador: upload retomável do Google Drive, direto do aparelho para o Google.
//
// Por arquivo: abre uma sessão retomável (POST …/upload/drive/v3/files?uploadType=resumable → Location) e manda
// pedaços com PUT + Content-Range. Blob.slice é preguiçoso: só o pedaço da vez é lido do disco.
//  - 308 + Range "bytes=0-N" → o próximo byte é N+1. Sem Range → nada gravado (0).
//  - 200/201 → pronto (conferimos o tamanho que o Drive diz ter recebido).
//  - Queda de rede, 5xx, 429, 403 de limite → recuo exponencial com jitter (até 64 s), pergunta o status e segue.
//  - 404/410 na sessão → sessão morreu: abre outra e recomeça do zero.
//  - 401 → renova o token e repete.
// A URI da sessão é uma credencial (vale ~1 semana): fica no IndexedDB para retomar depois de recarregar a página,
// mas nunca vai para o console nem para a tela.
//
// Os PUTs na sessão vão SEM Authorization: a URI da sessão já autoriza (docs do Drive e o mock fiel a eles).
// Assim um token que vence no meio de um arquivo grande não para o envio — e quando renovar demora (sem rede até o
// site da conta, ou Drive para reconectar), só os passos que precisam mesmo de token
// (conferir destino, abrir sessão) esperam.
// Se mesmo assim o Google responder 401 num PUT, passamos a mandar o token naquela sessão.
import { CHUNK_AUTO, LAN, getSettings, local } from './config.js'
import * as auth from './auth.js'
import { DriveError, backoffMs, createUploadSession, driveErrorFrom, findByName, isRetryable, sleep } from './drive.js'
import { allRecords, deleteRecord, getRecord, putRecord, sessionKey } from './idb.js'
import { LAN_MSG, lanDiscard, lanPut, lanStart, lanStatus } from './lan.js'
import { keepAwake } from './wakelock.js'
import { bytes } from './format.js'

const MiB = 1024 * 1024
const SESSION_MAX_AGE = 6 * 24 * 3600 * 1000 // o Google guarda 7 dias; folga de 1
const STALL_MS = 45_000 // sem progresso por tanto tempo = conexão travada
const MAX_FAILURES = 10 // falhas seguidas antes de desistir (com recuo até 64 s, dá vários minutos)
const MAX_RESTARTS = 3
const CAP_HITS = 4 // 403 userRateLimitExceeded seguidos = limite diário de 750 GB
const RANGE_SEEN_KEY = 'sobedesce.rangeVisible'

// ───── tamanho do pedaço ─────
//
// Em "Automático" (o padrão), cada pedaço é escolhido para durar ~4 s na velocidade que o anterior teve:
// clamp(velocidade × 4 s, 8 MiB, 64 MiB), arredondado para baixo a 256 KiB (o Google exige múltiplos disso).
// Rede boa: pedaços maiores, menos pausas entre um PUT e outro (o Wi-Fi rápido rende bem mais com 1 arquivo só).
// Rede ruim: volta sozinho para 8 MiB, e qualquer falha volta direto ao mínimo, para não perder muito numa queda.
// Cresce no máximo 2× por vez (uma medida boa por acaso não pula de 8 para 64).
// Memória: o pedaço é um Blob.slice do arquivo, preguiçoso. Nada é lido para a memória aqui: o navegador lê do disco
// enquanto manda, então um pedaço de 64 MiB não vira 64 MiB de RAM (vale também no Safari do iPhone).
export const GRAIN = 256 * 1024
export const AUTO_MIN = 8 * MiB
export const AUTO_MAX = 64 * MiB
export const AUTO_SECONDS = 4

/** Próximo pedaço em "Automático": `prev` é o pedaço anterior, `bytesPerSec` a velocidade que ele teve. */
export function chunkFor(prev, bytesPerSec) {
  if (!(bytesPerSec > 0)) return AUTO_MIN
  const want = Math.min(bytesPerSec * AUTO_SECONDS, (prev || AUTO_MIN) * 2)
  const clamped = Math.min(AUTO_MAX, Math.max(AUTO_MIN, want))
  return Math.floor(clamped / GRAIN) * GRAIN
}

// ───── modo "rede ruim no set" ─────
//
// O Safari do iPhone não tem navigator.connection, então a decisão vem do que acontece: 2 quedas em 5 minutos põem o
// envio no modo de rede instável; 10 minutos sem queda tiram. No modo: 1 arquivo por vez, pedaço de no máximo 4 MiB
// (cada pedaço confirmado é progresso guardado antes da próxima queda) e os arquivos menores primeiro.
// O teto de 4 MiB vale por cima do Automático e também de um tamanho fixo escolhido em Ajustes: é proteção.
// Vários arquivos caindo juntos são uma queda só (NET_MERGE_MS).
export const NET_DROPS = 2
export const NET_WINDOW_MS = 5 * 60_000
export const NET_STABLE_MS = 10 * 60_000
export const NET_MERGE_MS = 15_000
export const NET_CHUNK = 4 * MiB
export const NET_MSG = 'Rede instável: subindo um por vez'

export class NetWatch {
  constructor() {
    this.bad = false
    this.drops = [] // quedas contadas na janela de 5 min
    this.lastDropAt = 0 // última falha de rede (conta para os 10 min de estabilidade)
  }

  /** Uma falha de rede. true = acabou de entrar no modo. */
  drop(now = Date.now()) {
    this.lastDropAt = now
    const last = this.drops[this.drops.length - 1]
    if (last != null && now - last < NET_MERGE_MS) return false
    this.drops = this.drops.filter((t) => now - t < NET_WINDOW_MS)
    this.drops.push(now)
    if (!this.bad && this.drops.length >= NET_DROPS) {
      this.bad = true
      return true
    }
    return false
  }

  /** true = acabou de sair do modo (10 min sem queda). */
  check(now = Date.now()) {
    if (!this.bad || now - this.lastDropAt < NET_STABLE_MS) return false
    this.bad = false
    this.drops = []
    return true
  }
}

/** Quem decide o pedaço de um arquivo: fixo (Ajustes) ou acompanhando a rede. Lê os Ajustes a cada pedaço. */
class ChunkSizer {
  constructor(net) {
    this.auto = AUTO_MIN
    this.net = net
  }

  get size() {
    const { chunkMiB } = getSettings()
    const size = chunkMiB === CHUNK_AUTO ? this.auto : chunkMiB * MiB
    return this.net?.bad ? Math.min(size, NET_CHUNK) : size
  }

  /** Um pedaço de `bytes` chegou inteiro em `ms`. */
  ok(bytes, ms) {
    if (bytes < GRAIN || !(ms > 0)) return // fim do arquivo (pedaço curto) não diz nada da rede
    this.auto = chunkFor(this.auto, bytes / (ms / 1000))
  }

  /** Queda, 5xx, limite, travou: volta ao mínimo. */
  fail() {
    this.auto = AUTO_MIN
  }
}

// 'mac' (só no modo Wi-Fi): já chegou inteiro no computador, que está subindo pro Drive.
export const ACTIVE = new Set(['queued', 'preparing', 'running', 'paused', 'mac'])
const MAC_POLL_MS = 1500
const MAC_POLL_MAX = 6 // por rodada: com centenas de arquivos no computador, não dá para perguntar de todos a cada 1,5 s
const FINISHED = new Set(['done', 'skipped'])

const MSG = {
  network: 'A conexão caiu várias vezes seguidas. Confira a internet e toque em Tentar de novo — continua de onde parou.',
  quota: 'Seu Drive está cheio. Libere espaço e toque em Tentar de novo.',
  cap: 'O Google limita cada conta a 750 GB de envio por dia e esse limite chegou. Libera em até 24 horas; o que já subiu fica guardado.',
  restarts: 'O Google encerrou este envio várias vezes. Toque em Tentar de novo.',
  lanNetwork: 'A conexão com o computador caiu várias vezes seguidas. Confira o Wi-Fi e toque em Tentar de novo — continua de onde parou.',
  lanLost: 'O computador não tem mais este envio. Escolha o arquivo de novo.',
}

class Aborted extends Error {
  constructor(reason) {
    super(reason)
    this.aborted = true
  }
}

class UploadError extends Error {
  constructor(message, { cap = false } = {}) {
    super(message)
    this.cap = cap
  }
}

// ───── Range ─────
//
// O Google lista Range em Access-Control-Expose-Headers (a amostra oficial de upload por CORS lê esse header),
// então normalmente dá para ler. Mas se algum dia o navegador não puder ler, getResponseHeader devolve null —
// igual a "nada gravado". Decisão:
//  1. Range legível → usa.
//  2. Range ausente depois de um PUT de dados → tratamos como DESCONHECIDO e fazemos uma consulta de status.
//  3. Ainda ausente: se este navegador já nos mostrou Range alguma vez (rangeVisible), a ausência é real e o
//     próximo byte é 0, como o Google documenta. Se nunca mostrou (header escondido), usamos o fim do pedaço —
//     e SÓ quando aquele PUT terminou com 308 (o Google confirmou que recebeu o corpo inteiro). Fora disso
//     (consulta depois de queda), voltamos ao último fim de pedaço confirmado assim (session.acked).
//  4. Se a suposição do item 3 estiver errada, o próximo PUT começa depois do que o Google tem e ele responde
//     400; sem Range legível não há como saber o ponto certo, então recomeçamos o arquivo numa sessão nova.
//     Mais lento, nunca corrompe.
let rangeVisible = Boolean(local.get(RANGE_SEEN_KEY))

function markRangeSeen() {
  if (!rangeVisible) {
    rangeVisible = true
    local.set(RANGE_SEEN_KEY, true)
  }
}

function parseRange(header) {
  const m = /bytes\s*=\s*(\d+)\s*-\s*(\d+)/i.exec(header || '')
  return m ? Number(m[2]) + 1 : 0
}

function parseJson(text) {
  try {
    return JSON.parse(text || 'null')
  } catch {
    return null
  }
}

/**
 * Lê um header da resposta só se o CORS deixar. getAllResponseHeaders() lista apenas os expostos, então um header
 * escondido vira null sem o "Refused to get unsafe header" que getResponseHeader() escreve no console.
 */
function exposedHeader(xhr, name) {
  try {
    const all = xhr.getAllResponseHeaders() || ''
    const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(all)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function messageFor(err) {
  if (!err) return 'Algo deu errado. Toque em Tentar de novo.'
  if (err instanceof UploadError) return err.message
  if (err.lan) return err.message
  const r = err.reason
  if (r === 'storageQuotaExceeded') return MSG.quota
  if (r === 'userRateLimitExceeded') return MSG.cap
  if (r === 'teamDriveFileLimitExceeded') return 'Este drive compartilhado chegou ao limite de arquivos do Google.'
  if (r === 'numChildrenInNonRootLimitExceeded') return 'Esta pasta chegou ao limite de itens do Google. Escolha outra pasta.'
  if (r === 'insufficientFilePermissions' || r === 'forbidden' || r === 'insufficientPermissions')
    return 'Sua conta não tem permissão para enviar para esta pasta.'
  if (err.status === 404) return 'A pasta de destino não existe mais (ou você perdeu o acesso a ela).'
  if (err.status === 0) return MSG.network
  if (err.signedOut) return 'Você saiu da conta. Entre de novo para continuar.'
  return `O Google recusou o envio (${err.status || 'erro'}${r ? ` · ${r}` : ''}). Toque em Tentar de novo.`
}

let seq = 0

class Engine {
  constructor() {
    this.items = []
    this.running = new Set()
    this.notice = null // { kind: 'cap', text }
    this.account = null
    this.version = 0
    this._listeners = new Set()
    this._emitTimer = 0
    this._ticker = 0
    this._tickN = 0
    this._hiddenAt = 0
    this._restoredFor = undefined
    this._macTimer = 0 // modo Wi-Fi: acompanhamento dos que já estão no computador
    this.net = new NetWatch() // modo "rede ruim no set"
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this._onVisibility())
      window.addEventListener('beforeunload', (e) => {
        if (this.running.size) {
          e.preventDefault()
          e.returnValue = ''
        }
      })
    }
  }

  // ───── assinatura (a UI redesenha no máximo ~5×/s) ─────

  subscribe(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  changed(now = false) {
    if (now) {
      clearTimeout(this._emitTimer)
      this._emitTimer = 0
      this._emit()
      return
    }
    if (this._emitTimer) return
    this._emitTimer = setTimeout(() => {
      this._emitTimer = 0
      this._emit()
    }, 200)
  }

  _emit() {
    this.version++
    for (const fn of this._listeners) fn(this.version)
  }

  // ───── entrada ─────

  setAccount(email) {
    this.account = email || null
  }

  /** Sessões guardadas no aparelho viram itens "Pausado — escolha o arquivo de novo". */
  async restore() {
    if (this._restoredFor === this.account) return
    this._restoredFor = this.account
    const records = await allRecords()
    const now = Date.now()
    for (const rec of records) {
      if (!rec?.key) continue
      if (now - rec.createdAt > SESSION_MAX_AGE) {
        deleteRecord(rec.key)
        continue
      }
      if (rec.account && this.account && rec.account !== this.account) continue
      if (Boolean(rec.lan) !== Boolean(LAN)) continue
      if (this.items.some((it) => it.key === rec.key)) continue
      // Modo Wi-Fi: o que já está no computador não precisa do arquivo; só acompanhamos a subida pro Drive.
      const onMac = rec.lan && rec.phase === 'mac'
      this.items.push({
        ...this._blank(),
        name: rec.name,
        size: rec.size,
        lastModified: rec.lastModified,
        type: rec.type || '',
        folder: rec.folder,
        key: rec.key,
        status: onMac ? 'mac' : 'needsFile',
        offset: onMac ? rec.size : Math.min(rec.acked || 0, rec.size),
        addedAt: rec.createdAt,
        lanId: rec.lanId || null,
        lanMac: onMac,
      })
    }
    this._watchMac()
    this.changed(true)
  }

  _blank() {
    return {
      id: ++seq,
      file: null,
      name: '',
      size: 0,
      lastModified: 0,
      type: '',
      folder: null,
      key: '',
      status: 'queued',
      offset: 0,
      inflight: 0,
      speed: 0,
      note: '',
      error: null,
      fileId: null,
      sizeOk: false, // o Drive disse ter recebido exatamente o tamanho do arquivo (o celular não confere MD5)
      chunk: 0, // tamanho do pedaço da vez (bytes)
      forceCopy: false,
      addedAt: Date.now(),
      finishedAt: 0,
      lastProgressAt: 0,
      ctl: null,
      _lastBytes: 0,
      _lastAt: 0,
      // modo Wi-Fi
      lanId: null, // id do recebimento no computador
      lanMac: false, // já chegou inteiro no computador
      drive: null, // { status, bytesDone, size, speed, error, fileId } da subida do computador pro Drive
    }
  }

  /** Arquivos escolhidos: retoma os pausados que batem (nome, tamanho, data) e enfileira os novos. */
  addFiles(files, folder) {
    let added = 0
    let resumed = 0
    let dupes = 0
    for (const file of files) {
      const waiting = this.items.find(
        // No Wi-Fi o computador reconhece por nome + tamanho (a Fototeca muda a data a cada escolha).
        (it) => it.status === 'needsFile' && it.name === file.name && it.size === file.size && (LAN || it.lastModified === file.lastModified),
      )
      if (waiting) {
        waiting.file = file
        waiting.type = file.type || waiting.type
        waiting.status = 'queued'
        resumed++
        continue
      }
      const key = sessionKey(file, folder.id)
      if (this.items.some((it) => it.key === key && ACTIVE.has(it.status))) {
        dupes++
        continue
      }
      this.items.push({
        ...this._blank(),
        file,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type || '',
        folder,
        key,
      })
      added++
    }
    this.notice = null
    this.pump()
    this.changed(true)
    return { added, resumed, dupes }
  }

  // ───── controle ─────

  pump() {
    this._netCheck()
    const concurrency = this.net.bad ? 1 : getSettings().concurrency
    // Rede instável: o que falta menos primeiro (termina antes da próxima queda).
    const order = this.net.bad ? [...this.items].sort((a, b) => a.size - a.offset - (b.size - b.offset)) : this.items
    for (const it of order) {
      if (this.running.size >= concurrency) break
      // Item que já está no computador (Wi-Fi) não precisa do arquivo para "tentar de novo".
      if (it.status === 'queued' && (it.file || it.lanMac)) this._start(it)
    }
    this._activity()
  }

  pause(it) {
    if (it.status === 'queued') it.status = 'paused'
    else if (it.ctl) {
      this._abort(it, 'pause')
      it.status = 'paused'
      it.note = ''
    }
    this._activity()
    this.changed(true)
  }

  resume(it) {
    if (it.status !== 'paused') return
    it.authPaused = false
    it.status = 'queued'
    it.note = ''
    this.pump()
    this.changed(true)
  }

  pauseAll() {
    for (const it of this.items) if (it.status === 'queued' || it.status === 'preparing' || it.status === 'running') this.pause(it)
  }

  resumeAll() {
    this.notice = null
    for (const it of this.items) {
      if (it.status !== 'paused') continue
      it.authPaused = false
      it.status = 'queued'
    }
    this.pump()
    this.changed(true)
  }

  /** O Drive voltou (reconectado na conta): continua só o que pausou por falta de acesso. */
  resumeAuthPaused() {
    let n = 0
    for (const it of this.items) {
      if (it.status !== 'paused' || !it.authPaused) continue
      it.authPaused = false
      it.status = 'queued'
      n++
    }
    if (n) {
      this.pump()
      this.changed(true)
    }
    return n
  }

  retry(it) {
    if (it.status !== 'failed') return
    it.status = 'queued'
    it.error = null
    this.notice = null
    this.pump()
    this.changed(true)
  }

  /** "Enviar mesmo assim": sobe outra cópia com o mesmo nome. */
  sendAnyway(it) {
    if (it.status !== 'skipped') return
    it.forceCopy = true
    it.fileId = null
    it.offset = 0
    it.status = 'queued'
    this.pump()
    this.changed(true)
  }

  remove(it) {
    if (it.ctl) this._abort(it, 'remove')
    this.items = this.items.filter((x) => x !== it)
    if (LAN) {
      // Pela metade no computador: ele apaga o pedaço. Já inteiro lá: o computador termina de subir sozinho.
      if (it.lanId && !it.lanMac && !FINISHED.has(it.status)) lanDiscard(it.lanId)
      deleteRecord(it.key)
    } else if (!FINISHED.has(it.status)) {
      // Cancela a sessão no Google (cortesia) e esquece a retomada.
      getRecord(it.key).then((rec) => {
        if (rec?.uri) fetch(rec.uri, { method: 'DELETE' }).catch(() => {})
        deleteRecord(it.key)
      })
    }
    this._activity()
    this.changed(true)
  }

  clearFinished() {
    this.items = this.items.filter((it) => !FINISHED.has(it.status))
    this.changed(true)
  }

  hasWork() {
    return this.items.some((it) => it.status === 'queued' || it.status === 'preparing' || it.status === 'running')
  }

  // ───── rede instável ─────

  /** Uma queda de rede num envio (não conta pausa, remoção nem a volta do segundo plano). */
  _netDrop() {
    if (!this.net.drop()) return
    // Entrou no modo: fica só um arquivo andando (o que falta menos); os outros voltam para a fila e continuam
    // de onde pararam quando chegar a vez deles (a sessão e o que o Google confirmou ficam guardados).
    const running = [...this.running].filter((it) => it.ctl && (it.status === 'running' || it.status === 'preparing'))
    running.sort((a, b) => a.size - a.offset - (b.size - b.offset))
    for (const it of running.slice(1)) {
      this._abort(it, 'netmode')
      it.status = 'queued'
      it.note = ''
    }
    this.changed(true)
  }

  /** 10 min sem queda: sai do modo e volta a encher as vagas. */
  _netCheck() {
    if (!this.net.check()) return false
    this.changed(true)
    return true
  }

  _abort(it, reason) {
    const ctl = it.ctl
    if (!ctl) return
    ctl.aborted = reason
    ctl.abortCtl.abort()
    ctl.xhr?.abort()
  }

  _check(ctl) {
    if (ctl.aborted) throw new Aborted(ctl.aborted)
  }

  // ───── atividade: tela acesa, velocidade, token ─────

  _activity() {
    const busy = this.running.size > 0
    keepAwake(busy || this.items.some((it) => it.status === 'queued' && it.file))
    if (busy && !this._ticker) {
      this._ticker = setInterval(() => this._tick(), 500)
    } else if (!busy && this._ticker) {
      clearInterval(this._ticker)
      this._ticker = 0
    }
  }

  _tick() {
    const now = performance.now()
    for (const it of this.running) {
      const done = it.offset + it.inflight
      if (!it._lastAt) {
        it._lastAt = now
        it._lastBytes = done
        continue
      }
      const dt = (now - it._lastAt) / 1000
      if (dt < 0.4) continue
      const delta = Math.max(0, done - it._lastBytes)
      const inst = delta / dt
      it.speed = it.speed ? it.speed * 0.7 + inst * 0.3 : inst
      it._lastAt = now
      it._lastBytes = done
    }
    if (++this._tickN % 60 === 0) auth.ensureFresh()
    if (this._tickN % 4 === 0 && this.net.bad && this._netCheck()) this.pump()
    this.changed()
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') {
      this._hiddenAt = Date.now()
      return
    }
    const away = this._hiddenAt ? Date.now() - this._hiddenAt : 0
    this._hiddenAt = 0
    if (!this.running.size) return
    auth.ensureFresh()
    // O iOS corta a rede de páginas em segundo plano: uma requisição pode ter morrido sem avisar. Depois de um
    // instante visível, quem não deu sinal de vida é refeito (consulta de status e segue de onde o Google parou).
    setTimeout(() => {
      for (const it of this.running) {
        const ctl = it.ctl
        if (ctl?.xhr && away > 1000 && Date.now() - it.lastProgressAt > 2500) {
          ctl.resync = true
          ctl.xhr.abort()
        }
      }
    }, 1500)
  }

  // ───── um arquivo ─────

  _start(it) {
    it.status = 'preparing'
    it.error = null
    it.note = ''
    it.speed = 0
    it._lastAt = 0
    const ctl = { aborted: null, xhr: null, resync: false, abortCtl: new AbortController() }
    ctl.signal = ctl.abortCtl.signal
    it.ctl = ctl
    this.running.add(it)
    this._run(it, ctl)
      .catch((err) => {
        if (ctl.aborted) return
        if (err?.signedOut) {
          // Sem sessão na conta ou Drive para reconectar: pausa e continua quando a conta voltar.
          it.status = 'paused'
          it.note = ''
          it.authPaused = true
          return
        }
        this._fail(it, err)
      })
      .finally(() => {
        if (it.ctl === ctl) it.ctl = null
        it.inflight = 0
        it.speed = 0
        this.running.delete(it)
        this.pump()
        this.changed(true)
      })
    this.changed(true)
  }

  _fail(it, err) {
    it.status = 'failed'
    it.note = ''
    it.error = messageFor(err)
    if (err?.cap || err?.reason === 'userRateLimitExceeded') {
      // Limite diário: os outros também vão bater nele. Pausa a fila e avisa uma vez.
      this.notice = { kind: 'cap', text: MSG.cap }
      for (const other of this.items) if (other.status === 'queued') other.status = 'paused'
    }
  }

  async _run(it, ctl) {
    if (LAN) return this._runLan(it, ctl)
    let rec = await getRecord(it.key)
    if (rec && (Date.now() - rec.createdAt > SESSION_MAX_AGE || rec.size !== it.size)) {
      await deleteRecord(it.key)
      rec = null
    }
    this._check(ctl)

    if (!rec && !it.forceCopy) {
      it.note = 'Conferindo o destino…'
      this.changed()
      const found = await this._retrying(it, ctl, () => findByName(it.name, it.folder, ctl.signal))
      this._check(ctl)
      const same = found.find((f) => f.name === it.name && Number(f.size) === it.size)
      if (same) {
        it.status = 'skipped'
        it.fileId = same.id
        it.note = ''
        it.finishedAt = Date.now()
        return
      }
    }

    it.status = 'running'
    it.note = ''
    let session = null
    if (rec) {
      session = { uri: rec.uri, createdAt: rec.createdAt, acked: rec.acked || 0, useAuth: false }
      it.note = 'Conferindo o que já chegou…'
      this.changed()
      const st = await this._status(it, session, ctl, session.acked)
      if (st.done) return this._finish(it, st.done)
      if (st.gone) {
        await deleteRecord(it.key)
        session = null
      } else {
        it.offset = st.offset
        it.note = ''
      }
    }
    if (!session) session = await this._newSession(it, ctl)
    await this._loop(it, session, ctl)
  }

  async _newSession(it, ctl) {
    it.note = 'Abrindo o envio…'
    it.offset = 0
    this.changed()
    const uri = await this._retrying(it, ctl, () => createUploadSession(it.file, it.folder, ctl.signal))
    this._check(ctl)
    const session = { uri, createdAt: Date.now(), acked: 0, useAuth: false }
    await this._save(it, session)
    it.note = ''
    return session
  }

  _save(it, session) {
    return putRecord({
      key: it.key,
      uri: session.uri,
      createdAt: session.createdAt,
      acked: session.acked,
      name: it.name,
      size: it.size,
      lastModified: it.lastModified,
      type: it.type,
      folder: it.folder,
      account: this.account,
    })
  }

  /** Metadados (conferir destino, abrir sessão): o fetch já repete; aqui esperamos rede e tentamos mais. */
  async _retrying(it, ctl, fn) {
    for (let failures = 0; ; ) {
      try {
        return await fn()
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        if (err?.signedOut || !isRetryable(err) || ++failures > 3) throw err
        await this._waitBeforeRetry(it, ctl, failures + 2)
      }
    }
  }

  async _waitBeforeRetry(it, ctl, failures) {
    if (navigator.onLine === false) {
      it.note = LAN ? 'Sem Wi-Fi — continuo quando voltar' : 'Sem internet — continuo quando voltar'
      this.changed()
      await new Promise((resolve, reject) => {
        const done = () => {
          window.removeEventListener('online', done)
          ctl.signal.removeEventListener('abort', stop)
          resolve()
        }
        const stop = () => {
          window.removeEventListener('online', done)
          reject(new Aborted(ctl.aborted || 'abort'))
        }
        window.addEventListener('online', done)
        ctl.signal.addEventListener('abort', stop, { once: true })
      })
    }
    const ms = backoffMs(failures)
    it.note = `Conexão instável — tentando de novo em ${Math.max(1, Math.round(ms / 1000))} s`
    this.changed()
    try {
      await sleep(ms, ctl.signal)
    } catch {
      throw new Aborted(ctl.aborted || 'abort')
    }
    it.note = 'Conferindo o que já chegou…'
    this.changed()
  }

  async _restart(it, ctl, restarts, note) {
    if (restarts > MAX_RESTARTS) throw new UploadError(MSG.restarts)
    await deleteRecord(it.key)
    const session = await this._newSession(it, ctl)
    it.note = note || ''
    return session
  }

  async _loop(it, first, ctl) {
    let session = first
    const sizer = new ChunkSizer(this.net)
    let failures = 0
    let restarts = 0
    let capHits = 0
    let badRequests = 0

    // Consulta o status e ajusta o ponto de partida. Devolve o JSON final se o Google disser que já terminou.
    const resync = async (fallback) => {
      const st = await this._status(it, session, ctl, fallback)
      if (st.done) return st.done
      if (st.gone) {
        session = await this._restart(it, ctl, ++restarts, 'O envio expirou no Google; recomeçando este arquivo.')
        return null
      }
      it.offset = st.offset
      if (st.offset > session.acked) {
        session.acked = st.offset
        await this._save(it, session)
      }
      it.note = ''
      return null
    }

    for (;;) {
      this._check(ctl)
      const start = it.offset
      if (it.size > 0 && start >= it.size) {
        const done = await resync(it.size)
        if (done) return this._finish(it, done)
        if (it.offset >= it.size) throw new UploadError('O Google não confirmou o fim do envio. Toque em Tentar de novo.')
        continue
      }
      const end = Math.min(start + sizer.size, it.size)
      it.chunk = end - start
      const sentAt = performance.now()
      let r
      try {
        r = await this._put(it, session, ctl, start, end)
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        if (err?.signedOut) throw err
        sizer.fail()
        const wasResync = ctl.resync
        ctl.resync = false
        if (!wasResync) {
          this._netDrop()
          this._check(ctl) // o modo pode ter devolvido este arquivo para a fila
          if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
          await this._waitBeforeRetry(it, ctl, failures)
        } else {
          it.note = 'Conferindo o que já chegou…'
          this.changed()
        }
        const done = await resync(session.acked)
        if (done) return this._finish(it, done)
        continue
      }

      if (r.status === 308) {
        failures = 0
        capHits = 0
        badRequests = 0
        sizer.ok(end - start, performance.now() - sentAt)
        if (r.range != null) {
          markRangeSeen()
          it.offset = parseRange(r.range)
        } else {
          // Range ausente ou ilegível: desconhecido → consulta (fallback: fim deste pedaço, que terminou com 308).
          const done = await resync(end)
          if (done) return this._finish(it, done)
        }
        session.acked = it.offset
        await this._save(it, session)
        continue
      }
      if (r.status === 200 || r.status === 201) return this._finish(it, parseJson(r.text) || {})

      const err = driveErrorFrom(r.status, r.text)
      if (r.status === 404 || r.status === 410) {
        session = await this._restart(it, ctl, ++restarts, 'O envio expirou no Google; recomeçando este arquivo.')
        continue
      }
      if (r.status === 401) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        auth.invalidate()
        session.useAuth = true
        continue
      }
      if (err.reason === 'storageQuotaExceeded') throw new UploadError(MSG.quota)
      if (err.reason === 'userRateLimitExceeded' && ++capHits >= CAP_HITS) throw new UploadError(MSG.cap, { cap: true })
      if (isRetryable(err)) {
        sizer.fail()
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        await this._waitBeforeRetry(it, ctl, failures)
        const done = await resync(session.acked)
        if (done) return this._finish(it, done)
        continue
      }
      if (r.status === 400 || r.status === 416) {
        // Quase sempre: o pedaço começou depois do que o Google tem (ponto de partida desatualizado).
        if (!rangeVisible) {
          session = await this._restart(it, ctl, ++restarts, 'O Google não confirmou o progresso; recomeçando este arquivo.')
          continue
        }
        if (++badRequests > 3) throw err
        const done = await resync(0)
        if (done) return this._finish(it, done)
        continue
      }
      throw err
    }
  }

  /** Consulta de status: PUT vazio com Content-Range "bytes *\/TOTAL". → { offset } | { done } | { gone } */
  async _status(it, session, ctl, fallback) {
    let failures = 0
    for (;;) {
      this._check(ctl)
      let r
      try {
        r = await this._put(it, session, ctl, null, null)
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        if (err?.signedOut) throw err
        if (!ctl.resync) this._netDrop()
        ctl.resync = false
        this._check(ctl)
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        await this._waitBeforeRetry(it, ctl, failures)
        continue
      }
      if (r.status === 308) {
        if (r.range != null) {
          markRangeSeen()
          return { offset: Math.min(parseRange(r.range), it.size) }
        }
        // Sem Range legível: ver a decisão no topo (item 3).
        return { offset: rangeVisible ? 0 : Math.min(fallback || 0, it.size) }
      }
      if (r.status === 200 || r.status === 201) return { done: parseJson(r.text) || {} }
      if (r.status === 404 || r.status === 410) return { gone: true }
      if (r.status === 401) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        auth.invalidate()
        session.useAuth = true
        continue
      }
      const err = driveErrorFrom(r.status, r.text)
      if (isRetryable(err)) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        await this._waitBeforeRetry(it, ctl, failures)
        continue
      }
      // Qualquer outra resposta: a sessão está num estado que não dá para retomar.
      return { gone: true }
    }
  }

  /** Um PUT na sessão (XHR, para ter progresso do envio). start == null → consulta de status. */
  async _put(it, session, ctl, start, end) {
    const token = session.useAuth ? await auth.getToken() : null
    this._check(ctl)
    const data = start != null && end > start
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      ctl.xhr = xhr
      xhr.open('PUT', session.uri)
      xhr.setRequestHeader('Content-Range', data ? `bytes ${start}-${end - 1}/${it.size}` : `bytes */${it.size}`)
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      let last = performance.now()
      it.lastProgressAt = Date.now()
      const watchdog = setInterval(() => {
        if (performance.now() - last > STALL_MS) xhr.abort()
      }, 5000)
      const finish = (fn) => {
        clearInterval(watchdog)
        if (ctl.xhr === xhr) ctl.xhr = null
        it.inflight = 0
        fn()
      }
      if (data) {
        xhr.upload.onprogress = (e) => {
          last = performance.now()
          it.lastProgressAt = Date.now()
          it.inflight = Math.min(e.loaded, end - start)
        }
      }
      xhr.onload = () => finish(() => resolve({ status: xhr.status, range: exposedHeader(xhr, 'Range'), text: xhr.responseText }))
      xhr.onerror = () => finish(() => reject(new DriveError(0, 'network', 'A conexão caiu.')))
      xhr.onabort = () => finish(() => reject(new DriveError(0, 'aborted', 'Interrompido.')))
      xhr.ontimeout = () => finish(() => reject(new DriveError(0, 'timeout', 'A conexão travou.')))
      try {
        xhr.send(data ? it.file.slice(start, end, it.type || 'application/octet-stream') : null)
      } catch {
        finish(() => reject(new DriveError(0, 'network', 'Não consegui ler o arquivo.')))
      }
    })
  }

  // ───── modo Wi-Fi: pedaços para o computador, que sobe pro Drive ─────
  //
  // POST /m/api/uploads abre (ou acha) o recebimento; cada pedaço vai num PUT com Upload-Offset. O computador é a
  // fonte da verdade: 409 diz o ponto certo; depois de uma queda, GET devolve quanto chegou e seguimos dali.
  // Chegou tudo: a linha vira "No Mac · subindo pro Drive" e acompanhamos o envio do computador (sem ocupar vaga).

  async _runLan(it, ctl) {
    it.note = it.lanMac ? 'Conferindo no computador…' : 'Conectando ao computador…'
    this.changed()
    let view = await this._retrying(it, ctl, () => lanStart(it, it.folder, ctl.signal))
    this._check(ctl)
    it.lanId = view.id
    if (view.status === 'received') return this._toMac(it, view)
    if (view.status === 'failed') throw new UploadError(view.error || 'O computador não conseguiu guardar o arquivo. Toque em Tentar de novo.')
    if (!it.file) {
      // Era um item "no computador" mas lá não existe mais inteiro: precisa do arquivo de novo.
      it.status = 'needsFile'
      it.lanMac = false
      it.offset = view.offset
      it.note = ''
      return
    }
    it.status = 'running'
    it.offset = view.offset
    it.note = ''
    await this._saveLan(it, 'sending')
    const sizer = new ChunkSizer(this.net)
    let failures = 0
    let conflicts = 0
    let lost = 0

    // Depois de uma queda: pergunta ao computador quanto chegou.
    const resync = async () => {
      view = await this._retrying(it, ctl, () => lanStatus(it.lanId, ctl.signal))
      this._check(ctl)
      it.offset = view.offset
      it.note = ''
      return view.status === 'received'
    }

    for (;;) {
      this._check(ctl)
      if (it.offset >= it.size) {
        if (await resync()) return this._toMac(it, view)
        if (it.offset >= it.size) throw new UploadError('O computador não confirmou o fim do envio. Toque em Tentar de novo.')
        continue
      }
      const start = it.offset
      const end = Math.min(start + sizer.size, it.size)
      it.chunk = end - start
      const sentAt = performance.now()
      let r
      try {
        r = await this._lanChunk(it, ctl, start, end)
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        sizer.fail()
        const wasResync = ctl.resync
        ctl.resync = false
        if (!wasResync) {
          this._netDrop()
          this._check(ctl)
          if (++failures > MAX_FAILURES) throw new UploadError(MSG.lanNetwork)
          await this._waitBeforeRetry(it, ctl, failures)
        }
        if (await resync()) return this._toMac(it, view)
        continue
      }
      const j = r.json || {}
      if (r.status === 200) {
        failures = 0
        conflicts = 0
        sizer.ok(end - start, performance.now() - sentAt)
        it.offset = Number(j.offset) || end
        await this._saveLan(it, 'sending')
        if (j.status === 'received') return this._toMac(it, j)
        continue
      }
      if (r.status === 409 && Number.isFinite(j.offset)) {
        // O computador está em outro ponto (pedaço repetido depois de uma queda): segue de lá.
        if (++conflicts > 5) throw new UploadError('O computador e o celular não se entenderam sobre o ponto do envio. Toque em Tentar de novo.')
        if (j.status === 'received' && (await resync())) return this._toMac(it, view)
        it.offset = j.offset
        continue
      }
      if (r.status === 404) {
        // O computador esqueceu este recebimento (limpeza ou pasta de dados nova): começa outro.
        if (++lost > 2) throw new UploadError(MSG.lanLost)
        await deleteRecord(it.key)
        view = await this._retrying(it, ctl, () => lanStart(it, it.folder, ctl.signal))
        it.lanId = view.id
        it.offset = view.offset
        if (view.status === 'received') return this._toMac(it, view)
        continue
      }
      if (r.status === 401) throw new UploadError(LAN_MSG.code)
      // Disco cheio / sem permissão no computador: repetir não resolve; a mensagem dele explica o que fazer.
      if (r.status === 507) throw new UploadError(j.error || 'O computador não conseguiu gravar o arquivo.')
      if (r.status === 429 || r.status >= 500) {
        sizer.fail()
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.lanNetwork)
        await this._waitBeforeRetry(it, ctl, failures)
        if (await resync()) return this._toMac(it, view)
        continue
      }
      throw new UploadError(j.error || `O computador recusou o envio (${r.status}). Toque em Tentar de novo.`)
    }
  }

  /** Um pedaço para o computador, com progresso e o mesmo detector de travamento do envio para o Google. */
  async _lanChunk(it, ctl, start, end) {
    this._check(ctl)
    let last = performance.now()
    it.lastProgressAt = Date.now()
    const watchdog = setInterval(() => {
      if (performance.now() - last > STALL_MS) ctl.xhr?.abort()
    }, 5000)
    try {
      return await lanPut(it.lanId, start, it.file.slice(start, end, it.type || 'application/octet-stream'), {
        register: (xhr) => (ctl.xhr = xhr),
        onProgress: (loaded) => {
          last = performance.now()
          it.lastProgressAt = Date.now()
          it.inflight = Math.min(loaded, end - start)
        },
      })
    } finally {
      clearInterval(watchdog)
      ctl.xhr = null
      it.inflight = 0
    }
  }

  _saveLan(it, phase) {
    return putRecord({
      key: it.key,
      lan: true,
      lanId: it.lanId,
      phase,
      acked: it.offset,
      createdAt: it.addedAt,
      name: it.name,
      size: it.size,
      lastModified: it.lastModified,
      type: it.type,
      folder: it.folder,
      account: this.account,
    })
  }

  /** Chegou inteiro no computador: a vaga fica livre e a linha passa a mostrar a subida pro Drive. */
  async _toMac(it, view) {
    it.status = 'mac'
    it.lanMac = true
    it.lanId = view.id || it.lanId
    it.offset = it.size
    it.inflight = 0
    it.note = ''
    it.error = null
    this._applyDrive(it, view.drive)
    if (it.status === 'mac') await this._saveLan(it, 'mac')
    this._watchMac()
  }

  /** Estado do envio do computador pro Drive → estado da linha. */
  _applyDrive(it, drive) {
    it.drive = drive || null
    if (!drive) return
    if (drive.status === 'completed' || drive.status === 'skipped') {
      it.status = drive.status === 'completed' ? 'done' : 'skipped'
      it.fileId = drive.fileId || null
      it.finishedAt = Date.now()
      deleteRecord(it.key)
    } else if (drive.status === 'failed' || drive.status === 'canceled') {
      it.status = 'failed'
      it.error = `Chegou no computador, mas não subiu pro Drive: ${drive.error || (drive.status === 'canceled' ? 'cancelado no computador' : 'erro')}.`
    }
  }

  /** Acompanha (a cada 1,5 s) os arquivos que já estão no computador até subirem pro Drive. */
  _watchMac() {
    if (!LAN || this._macTimer) return
    const tick = async () => {
      const all = this.items.filter((it) => it.status === 'mac' && it.lanId)
      if (!all.length) {
        this._macTimer = 0
        return
      }
      // Primeiro os que estão subindo agora; depois os que faz mais tempo que não perguntamos.
      const rank = (it) => (it.drive?.status === 'running' || it.drive?.status === 'verifying' ? 0 : 1)
      const list = all.sort((a, b) => rank(a) - rank(b) || (a._polledAt || 0) - (b._polledAt || 0)).slice(0, MAC_POLL_MAX)
      await Promise.all(
        list.map(async (it) => {
          it._polledAt = Date.now()
          try {
            const view = await lanStatus(it.lanId)
            if (it.status !== 'mac') return
            it.note = ''
            if (view.status === 'received') this._applyDrive(it, view.drive)
            else if (view.status === 'failed') {
              it.status = 'failed'
              it.error = view.error || 'O computador não conseguiu guardar o arquivo.'
            }
          } catch (err) {
            if (it.status !== 'mac') return
            if (err?.status === 404) {
              it.status = 'failed'
              it.error = MSG.lanLost
              deleteRecord(it.key)
            } else if (err?.status === 401) {
              it.note = LAN_MSG.code
            } else {
              it.note = 'Sem conexão com o computador agora'
            }
          }
        }),
      )
      this.changed()
      this._macTimer = setTimeout(tick, MAC_POLL_MS)
    }
    this._macTimer = setTimeout(tick, 400)
  }

  async _finish(it, json) {
    const size = json && json.size != null ? Number(json.size) : null
    if (size != null && size !== it.size) {
      await deleteRecord(it.key)
      throw new UploadError(`O Drive recebeu ${bytes(size)} em vez de ${bytes(it.size)}. Toque em Tentar de novo para enviar outra vez.`)
    }
    it.status = 'done'
    it.sizeOk = size != null
    it.fileId = json?.id || null
    it.offset = it.size
    it.inflight = 0
    it.note = ''
    it.finishedAt = Date.now()
    await deleteRecord(it.key)
  }
}

export const engine = new Engine()

/** Resumo para o medidor do topo. */
export function summarize(items) {
  let total = 0
  let finished = 0
  let remaining = 0
  let speed = 0
  let running = 0
  let pending = 0
  let paused = 0
  let failed = 0
  let waitingFile = 0
  let onMac = 0
  for (const it of items) {
    total++
    if (FINISHED.has(it.status)) {
      finished++
      continue
    }
    const left = Math.max(0, it.size - it.offset - it.inflight)
    if (it.status === 'failed') failed++
    else if (it.status === 'needsFile') waitingFile++
    else if (it.status === 'mac') onMac++ // a parte do celular acabou; o computador termina sozinho
    else {
      remaining += left
      if (it.status === 'paused') paused++
      else pending++
      if (it.status === 'running' || it.status === 'preparing') {
        running++
        speed += it.speed || 0
      }
    }
  }
  return { total, finished, remaining, speed, running, pending, paused, failed, waitingFile, onMac, eta: speed > 0 ? remaining / speed : null }
}
