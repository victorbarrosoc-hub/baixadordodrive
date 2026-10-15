// Caminhos, endpoints e ajustes do app.
// Tudo o que é configurável fica aqui, para o resto do código não depender de process.env.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { JsonFile } from './util/store.js'

export const APP_NAME = 'SOBEDESCE'
export const APP_ID = 'sobedesce'
export const APP_VERSION = '0.1.0'

const MiB = 1024 * 1024

/** Pasta de dados do app (tokens, fila, cache de hash). SOBEDESCE_HOME sobrescreve (usado nos testes). */
export function dataDir() {
  const dir = process.env.SOBEDESCE_HOME || path.join(os.homedir(), '.sobedesce')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function dataPaths(root = dataDir()) {
  return {
    root,
    settings: path.join(root, 'settings.json'),
    credentials: path.join(root, 'credentials.json'),
    accounts: path.join(root, 'accounts.json'),
    queue: path.join(root, 'queue.json'),
    hashCache: path.join(root, 'hash-cache.json'),
    compares: path.join(root, 'compares'),
    logs: path.join(root, 'logs'),
  }
}

/**
 * Endpoints do Google. Variáveis SOBEDESCE_* permitem apontar para o servidor falso dos testes/demo.
 * Leia sempre via endpoints() (não guarde em constante de módulo) para os testes poderem trocar o env.
 */
export function endpoints() {
  const e = process.env
  return {
    driveApi: e.SOBEDESCE_DRIVE_API || 'https://www.googleapis.com/drive/v3',
    driveUpload: e.SOBEDESCE_DRIVE_UPLOAD || 'https://www.googleapis.com/upload/drive/v3',
    oauthAuth: e.SOBEDESCE_OAUTH_AUTH || 'https://accounts.google.com/o/oauth2/v2/auth',
    oauthToken: e.SOBEDESCE_OAUTH_TOKEN || 'https://oauth2.googleapis.com/token',
    oauthRevoke: e.SOBEDESCE_OAUTH_REVOKE || 'https://oauth2.googleapis.com/revoke',
  }
}

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

export const DEFAULT_SETTINGS = Object.freeze({
  /** Pasta padrão para downloads. */
  downloadDir: path.join(os.homedir(), 'Downloads'),
  /** Quantos arquivos baixam ao mesmo tempo. */
  maxConcurrentDownloads: 3,
  /** Quantos arquivos sobem ao mesmo tempo (o Drive não aceita partes paralelas de um mesmo arquivo). */
  maxConcurrentUploads: 3,
  /** Conexões simultâneas por arquivo baixado (download segmentado). */
  connectionsPerDownload: 8,
  /** Menor pedaço que vale a pena abrir uma conexão nova. */
  minSegmentSize: 16 * MiB,
  /** Tamanho de cada pedaço do upload retomável (múltiplo de 256 KiB). 0 = envia o restante numa requisição só. */
  uploadChunkSize: 256 * MiB,
  /** Limite de banda em bytes/s. 0 = sem limite. */
  bandwidthLimitDown: 0,
  bandwidthLimitUp: 0,
  /** Confere MD5 depois de baixar/subir. */
  verifyChecksums: true,
  /** Ao abrir o app, continua o que estava em andamento. */
  autoResume: true,
  /** Impede o computador de dormir enquanto houver transferência ativa. */
  keepAwake: true,
  /** Download quando já existe arquivo local: 'skip' (pula se mesmo tamanho), 'rename', 'overwrite'. */
  downloadConflict: 'skip',
  /** Upload quando já existe no Drive: 'skip' (pula se igual), 'rename' (sobe cópia), 'replace' (nova versão). */
  uploadConflict: 'skip',
  /** Sem receber/enviar nenhum byte por esse tempo, a conexão é refeita. */
  stallTimeoutMs: 30_000,
  /** Refaz conexões que ficaram muito mais lentas que as outras (o Google às vezes estrangula uma conexão). */
  restartSlowConnections: true,
  /** Mostrar arquivos ocultos no navegador local. */
  showHiddenFiles: false,
  /** 'system' | 'light' | 'dark' */
  theme: 'system',
})

const LIMITS = {
  maxConcurrentDownloads: [1, 16],
  maxConcurrentUploads: [1, 16],
  connectionsPerDownload: [1, 32],
  minSegmentSize: [1 * MiB, 1024 * MiB],
  uploadChunkSize: [0, 4096 * MiB],
  bandwidthLimitDown: [0, Number.MAX_SAFE_INTEGER],
  bandwidthLimitUp: [0, Number.MAX_SAFE_INTEGER],
  stallTimeoutMs: [5_000, 600_000],
}
const ENUMS = {
  downloadConflict: ['skip', 'rename', 'overwrite'],
  uploadConflict: ['skip', 'rename', 'replace'],
  theme: ['system', 'light', 'dark'],
}
const CHUNK_ALIGN = 256 * 1024

/** Valida e normaliza um patch de ajustes. Campos desconhecidos são ignorados. Lança Error com mensagem em PT-BR. */
export function validateSettings(patch, base = DEFAULT_SETTINGS) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue
    const def = DEFAULT_SETTINGS[key]
    if (typeof def === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(`Valor inválido para ${key}`)
      const [min, max] = LIMITS[key] || [-Infinity, Infinity]
      let v = Math.round(Math.min(max, Math.max(min, n)))
      if (key === 'uploadChunkSize' && v > 0) v = Math.max(CHUNK_ALIGN, Math.round(v / CHUNK_ALIGN) * CHUNK_ALIGN)
      out[key] = v
    } else if (typeof def === 'boolean') {
      out[key] = Boolean(value)
    } else if (ENUMS[key]) {
      if (!ENUMS[key].includes(value)) throw new Error(`Valor inválido para ${key}`)
      out[key] = value
    } else if (typeof def === 'string') {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Valor inválido para ${key}`)
      out[key] = key === 'downloadDir' ? path.resolve(value.trim()) : value.trim()
    }
  }
  return out
}

/**
 * Ajustes vivos. O motor lê `settings.get()` a cada decisão, então mudanças valem na hora.
 * Emite 'change' (novo objeto, chaves alteradas).
 */
export class Settings extends EventEmitter {
  constructor(file = dataPaths().settings) {
    super()
    this.file = new JsonFile(file, {})
    this.current = { ...DEFAULT_SETTINGS }
  }

  async load() {
    const raw = await this.file.load()
    try {
      this.current = validateSettings(raw)
    } catch {
      this.current = { ...DEFAULT_SETTINGS }
    }
    return this.current
  }

  get() {
    return this.current
  }

  async update(patch) {
    const next = validateSettings(patch, this.current)
    const changed = Object.keys(next).filter(k => next[k] !== this.current[k])
    this.current = next
    this.file.data = next
    await this.file.save()
    if (changed.length) this.emit('change', next, changed)
    return next
  }
}
