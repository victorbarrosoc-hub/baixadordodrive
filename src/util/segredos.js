// Segredos no disco (refresh tokens do Google, sessão da conta SOBEDESCE, chave OAuth própria) com a proteção do sistema.
//
// No app de desktop, a "guarda" é o safeStorage do Electron (Keychain no Mac, DPAPI no Windows), que só existe no processo
// principal: o motor (utilityProcess) pede para cifrar e decifrar por mensagens (guardaPorMensagens, desktop/cofre.js).
// Fora do Electron (npm start, testes, modo servidor) não há guarda e tudo segue como antes: JSON com modo 0600.
//
// Guarda = { nome, disponivel(): Promise<boolean>|boolean, cifrar(texto): Promise<Buffer>, decifrar(Buffer): Promise<string> }
//
// Arquivos: o segredo de `accounts.json` passa a morar em `accounts.cifrado.json` (envelope JSON 0600 com o conteúdo
// cifrado em base64). Migração transparente: com a guarda disponível, o JSON antigo é lido, cifrado, gravado no novo,
// conferido (decifrado de volta) e só então apagado. Nada é apagado sem cópia legível: um arquivo cifrado que não abre
// (dado corrompido, Keychain negado, outro computador) fica onde está e, se for preciso gravar por cima, vira
// `<nome>.guardado-<data>` antes.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { readJSON, writeJSONAtomic } from './store.js'

const MARCA = 'sobedesce-cofre'
const VERSAO = 1

/** `accounts.json` → `accounts.cifrado.json`. */
export function caminhoCifrado(file) {
  return /\.json$/i.test(file) ? file.replace(/\.json$/i, '.cifrado.json') : `${file}.cifrado.json`
}

async function mtime(file) {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

let avisouSemGuarda = false

/**
 * Um JSON com segredos. `ler()` / `gravar(dados)` / `apagar()`; a guarda é opcional.
 * Sem guarda (ou com ela indisponível) é exatamente o JSON 0600 de sempre.
 */
export class ArquivoSecreto {
  /**
   * @param {string} file caminho do JSON em texto (o "antigo"; continua sendo usado sem guarda)
   * @param {{ guarda?: object|null, log?: Function, nome?: string }} [opts]
   */
  constructor(file, { guarda = null, log, nome } = {}) {
    this.file = file
    this.cifrado = caminhoCifrado(file)
    this.guarda = guarda
    this.nome = nome || file.split(/[\\/]/).pop()
    this.log = log || ((...a) => console.warn('[cofre]', ...a))
    this.preservar = false // há um cifrado que não foi lido (não abriu, ou ficou para trás): antes de gravar por cima, guarda uma cópia
    this.disponivelCache = null
    this.fila = Promise.resolve() // gravar/apagar em ordem: um "apagar" (sair da conta) nunca perde para uma gravação antiga
  }

  #emFila(fn) {
    const next = this.fila.catch(() => {}).then(fn)
    this.fila = next
    return next
  }

  /** A guarda funciona agora? (pergunta uma vez por arquivo; falha = indisponível) */
  async #disponivel() {
    if (!this.guarda) return false
    if (this.disponivelCache == null) {
      try {
        this.disponivelCache = Boolean(await this.guarda.disponivel())
      } catch {
        this.disponivelCache = false
      }
      if (!this.disponivelCache && !avisouSemGuarda) {
        avisouSemGuarda = true
        this.log('a proteção do sistema (Keychain/DPAPI/keyring) não está disponível: os segredos seguem em arquivo 0600, como antes.')
      }
    }
    return this.disponivelCache
  }

  /** Onde os segredos estão agora: 'sistema' (cifrados pela guarda) ou 'arquivo' (JSON 0600). */
  async protecao() {
    return (await this.#disponivel()) ? 'sistema' : 'arquivo'
  }

  async #lerCifrado() {
    let env
    try {
      env = JSON.parse(await fs.readFile(this.cifrado, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return { existe: false }
      return { existe: true, erro: 'formato' }
    }
    if (!env || env[MARCA] !== VERSAO || typeof env.dados !== 'string') return { existe: true, erro: 'formato' }
    try {
      const texto = await this.guarda.decifrar(Buffer.from(env.dados, 'base64'))
      return { existe: true, dados: JSON.parse(texto) }
    } catch {
      return { existe: true, erro: 'decifrar' }
    }
  }

  async #gravarCifrado(dados) {
    const texto = JSON.stringify(dados)
    const buf = await this.guarda.cifrar(texto)
    // Confere antes de confiar: o que foi cifrado tem que voltar igual (senão o JSON antigo não pode ser apagado).
    if ((await this.guarda.decifrar(Buffer.from(buf))) !== texto) throw new Error('a proteção do sistema devolveu outro conteúdo')
    if (this.preservar) {
      await fs.rename(this.cifrado, `${this.cifrado}.guardado-${Date.now()}`).catch(() => {})
      this.preservar = false
    }
    await writeJSONAtomic(this.cifrado, { [MARCA]: VERSAO, guarda: this.guarda.nome || 'sistema', dados: Buffer.from(buf).toString('base64') }, { mode: 0o600 })
  }

  /** Lê os dados (migrando o JSON antigo, se for o caso). `fallback` quando não há nada legível. */
  async ler(fallback = null) {
    if (!(await this.#disponivel())) {
      if ((await mtime(this.cifrado)) != null && (await mtime(this.file)) == null) {
        this.log(`${this.nome}: está cifrado e a proteção do sistema não respondeu agora; fica guardado para a próxima abertura.`)
      }
      return readJSON(this.file, fallback)
    }
    const [tCifrado, tTexto] = await Promise.all([mtime(this.cifrado), mtime(this.file)])
    if (tCifrado != null && (tTexto == null || tCifrado >= tTexto)) {
      const r = await this.#lerCifrado()
      if (r.dados !== undefined) {
        // Sobrou o JSON antigo (queda entre gravar o novo e apagar o antigo): é mais velho, pode ir.
        if (tTexto != null) await fs.rm(this.file, { force: true }).catch(() => {})
        return r.dados
      }
      this.preservar = true
      this.log(`${this.nome}: não deu para abrir o arquivo cifrado (${r.erro === 'formato' ? 'dado corrompido' : 'a proteção do sistema recusou'}); ele fica guardado e o app segue sem ele.`)
      if (tTexto == null) return fallback
    }
    // JSON antigo (ou mais novo que o cifrado, gravado numa abertura sem a guarda): migra. Um cifrado que ficou para
    // trás sem ser lido não é apagado: vira cópia ao lado.
    if (tCifrado != null) this.preservar = true
    const dados = await readJSON(this.file, null)
    if (dados == null) return fallback
    try {
      await this.#gravarCifrado(dados)
      await fs.rm(this.file, { force: true })
      this.log(`${this.nome}: migrado para a proteção do sistema.`)
    } catch (err) {
      this.log(`${this.nome}: não deu para cifrar agora (${err?.message || err}); segue em arquivo 0600.`)
    }
    return dados
  }

  /** Grava os dados (cifrados, se der; senão JSON 0600). As gravações e o apagar vão em ordem. */
  gravar(dados) {
    return this.#emFila(() => this.#gravar(dados))
  }

  async #gravar(dados) {
    if (await this.#disponivel()) {
      try {
        await this.#gravarCifrado(dados)
        await fs.rm(this.file, { force: true }).catch(() => {})
        return
      } catch (err) {
        this.log(`${this.nome}: não deu para cifrar (${err?.message || err}); gravado em arquivo 0600.`)
      }
    }
    await writeJSONAtomic(this.file, dados, { mode: 0o600 })
  }

  /** Apaga as duas formas (sair da conta, remover o último Drive). */
  apagar() {
    return this.#emFila(() => Promise.all([fs.rm(this.file, { force: true }), fs.rm(this.cifrado, { force: true })]))
  }
}

/**
 * Guarda que conversa por mensagens (o motor no utilityProcess pedindo ao processo principal do Electron).
 * `enviar(msg)` manda `{ type: 'cofre', id, op: 'estado'|'cifrar'|'decifrar', dados? }`; quem recebe a resposta
 * (`{ type: 'cofre-resposta', id, ok, disponivel?, dados?, erro? }`) chama `receber(msg)`. `dados` em base64.
 */
export function guardaPorMensagens(enviar, { timeoutMs = 120_000 } = {}) {
  let seq = 0
  const pendentes = new Map()
  const pedir = (op, dados) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      // Tempo longo: no Mac o Keychain pode perguntar "Permitir" e a pessoa demorar para responder.
      const timer = setTimeout(() => {
        pendentes.delete(id)
        reject(new Error('a proteção do sistema não respondeu'))
      }, timeoutMs)
      pendentes.set(id, msg => {
        clearTimeout(timer)
        pendentes.delete(id)
        if (msg.ok) resolve(msg)
        else reject(new Error(msg.erro || 'a proteção do sistema recusou'))
      })
      try {
        enviar({ type: 'cofre', id, op, ...(dados !== undefined ? { dados } : {}) })
      } catch (err) {
        clearTimeout(timer)
        pendentes.delete(id)
        reject(err)
      }
    })
  let estado = null
  return {
    nome: 'electron-safeStorage',
    receber(msg) {
      if (msg?.type === 'cofre-resposta') pendentes.get(msg.id)?.(msg)
    },
    async disponivel() {
      estado ??= pedir('estado').then(
        r => Boolean(r.disponivel),
        () => false,
      )
      return estado
    },
    async cifrar(texto) {
      const r = await pedir('cifrar', Buffer.from(String(texto), 'utf8').toString('base64'))
      return Buffer.from(r.dados, 'base64')
    },
    async decifrar(buf) {
      const r = await pedir('decifrar', Buffer.from(buf).toString('base64'))
      return Buffer.from(r.dados, 'base64').toString('utf8')
    },
  }
}

/**
 * Guarda em memória para os testes (AES-256-GCM com chave aleatória): cifra de verdade, mas a chave some com o processo.
 * `disponivel: false` simula Linux sem keyring; `quebrada: true` simula o Keychain recusando.
 */
export function guardaEmMemoria({ disponivel = true, quebrada = false, chave = crypto.randomBytes(32) } = {}) {
  return {
    nome: 'memoria',
    chave,
    async disponivel() {
      return disponivel
    },
    async cifrar(texto) {
      if (quebrada) throw new Error('recusado')
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', chave, iv)
      const corpo = Buffer.concat([c.update(String(texto), 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), corpo])
    },
    async decifrar(buf) {
      if (quebrada) throw new Error('recusado')
      const b = Buffer.from(buf)
      const d = crypto.createDecipheriv('aes-256-gcm', chave, b.subarray(0, 12))
      d.setAuthTag(b.subarray(12, 28))
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
    },
  }
}
