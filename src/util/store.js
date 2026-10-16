// Persistência em JSON à prova de queda: escreve num arquivo temporário, faz fsync e renomeia.
// Uma queda no meio da gravação deixa o arquivo antigo intacto, nunca um JSON pela metade.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const chains = new Map() // arquivo -> promessa da última gravação (serializa gravações no mesmo arquivo)

export async function readJSON(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    if (err instanceof SyntaxError) {
      // Arquivo corrompido (ex.: disco cheio numa versão antiga). Guarda uma cópia e segue com o padrão.
      await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      return fallback
    }
    throw err
  }
}

async function writeNow(file, data, mode, space) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`
  const handle = await fs.open(tmp, 'w', mode)
  try {
    try {
      await handle.writeFile(space ? JSON.stringify(data, null, space) : JSON.stringify(data))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, file)
  } catch (err) {
    // Sem isso, cada tentativa com disco cheio deixaria mais um temporário para trás.
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * Grava `data` em `file` de forma atômica. Gravações concorrentes no mesmo arquivo são enfileiradas.
 * `space`: recuo do JSON (1 = legível, o padrão; 0 = compacto, para arquivos grandes como a fila).
 */
export function writeJSONAtomic(file, data, { mode = 0o600, space = 1 } = {}) {
  const prev = chains.get(file) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => writeNow(file, data, mode, space))
  chains.set(file, next)
  next.finally(() => {
    if (chains.get(file) === next) chains.delete(file)
  }).catch(() => {})
  return next
}

/**
 * Um arquivo JSON com dados em memória.
 * `saveSoon()` agrupa várias mudanças numa gravação só (útil para progresso que muda várias vezes por segundo).
 */
export class JsonFile {
  constructor(file, defaults = {}) {
    this.path = file
    this.defaults = defaults
    this.data = structuredClone(defaults)
    this.timer = null
    this.onError = null // (err) => void, chamado se uma gravação agendada falhar
    this.space = 1 // recuo do JSON gravado (0 = compacto)
  }

  async load() {
    const raw = await readJSON(this.path, null)
    this.data = raw == null ? structuredClone(this.defaults) : raw
    return this.data
  }

  /** Grava agora (cancela gravação agendada). */
  async save() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const snapshot = typeof this.serialize === 'function' ? this.serialize(this.data) : this.data
    await writeJSONAtomic(this.path, snapshot, { space: this.space })
  }

  /** Agenda uma gravação em até `delayMs`. Chamadas repetidas dentro da janela viram uma gravação só. */
  saveSoon(delayMs = 1000) {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.save().catch(err => this.onError?.(err))
    }, delayMs)
    this.timer.unref?.()
  }

  /** Grava imediatamente se houver gravação agendada (chamar ao encerrar o app). */
  async flush() {
    if (this.timer) await this.save()
  }
}
