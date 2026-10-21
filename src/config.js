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
    mobile: path.join(root, 'mobile.json'), // código de acesso do celular
    mobileUploads: path.join(root, 'mobile-uploads.json'), // recebimentos do celular (para retomar)
    cloud: path.join(root, 'cloud.json'), // sessão da conta SOBEDESCE neste computador (token do dispositivo, modo 0600)
    uso: path.join(root, 'uso.json'), // contagem por dia (bytes, arquivos, erros), sem nome de arquivo; vai para a conta
    thumbs: path.join(root, 'thumbs'), // miniaturas do Drive já baixadas (cache da tela Drive; pode apagar)
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

export const DEFAULT_CLOUD_URL = 'https://sobedesce.com'

/**
 * Endereço do site das contas SOBEDESCE (docs/CONTAS.md). SOBEDESCE_CLOUD_URL troca (testes e demo).
 * Só https, ou http em 127.0.0.1/localhost: o token do dispositivo nunca viaja sem criptografia pela rede.
 */
export function cloudUrl() {
  const raw = String(process.env.SOBEDESCE_CLOUD_URL || '').trim()
  if (!raw) return DEFAULT_CLOUD_URL
  try {
    const u = new URL(raw)
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    if (u.username || u.password) return DEFAULT_CLOUD_URL
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u.origin
  } catch {}
  return DEFAULT_CLOUD_URL
}

export const DEFAULT_SETTINGS = Object.freeze({
  /** Pasta padrão para downloads. */
  downloadDir: path.join(os.homedir(), 'Downloads'),
  /** Quantos arquivos baixam ao mesmo tempo. */
  maxConcurrentDownloads: 3,
  /** Quantos arquivos sobem ao mesmo tempo (o Drive não aceita partes paralelas de um mesmo arquivo). */
  maxConcurrentUploads: 4,
  /** Conexões simultâneas por arquivo baixado (download segmentado). */
  connectionsPerDownload: 8,
  /** Tamanho mínimo de cada segmento inicial do download (rclone usa 64 MiB; segmentos grandes economizam cota da API). */
  minSegmentSize: 64 * MiB,
  /**
   * Upload retomável: 0 = "contínuo" (o restante do arquivo numa requisição só, sem pausas entre pedaços —
   * é o que o Google recomenda). Valor > 0 = pedaços desse tamanho (múltiplo de 256 KiB), útil em redes
   * que derrubam conexões longas.
   */
  uploadChunkSize: 0,
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
  /**
   * Ao terminar de subir um .braw (o Drive não gera miniatura de Blackmagic RAW), tira um frame com o que o
   * computador tem (Quick Look no Mac, miniatura do Explorer no Windows) e grava como miniatura do arquivo.
   */
  brawThumbnails: true,
  /** "Gerar miniaturas" (tela Drive): a última pasta do computador escolhida para achar os originais ('' = nenhuma). */
  rawThumbLocalDir: '',
  /** Referências: a pessoa já viu o aviso de primeiro uso ("Salve só para referência dos seus projetos…"). */
  referenciasAvisoVisto: false,
  /** Referências: a passada que converte para H.264 as antigas que o iPhone não toca já terminou (src/referencias/celular.js). */
  referenciasCelular: false,
  /**
   * Proxy (prévia leve) ao enviar: ao terminar de subir um vídeo pesado, gera uma cópia H.264 em 1080p e sobe em
   * Proxy/<nome>.mp4, ao lado do original, para a prévia tocar fluida no celular, no app e no site. O original não muda.
   * 'sempre' | 'perguntar' (a tela de envio pergunta; quem não pergunta, como o celular, gera) | 'nunca'.
   * Cada envio e cada arquivo podem mudar isso (record.proxy). Substitui o antigo `previaLeve` (true → sempre, false → nunca).
   */
  proxyAoEnviar: 'sempre',
  /** "Gerar prévias" (tela Drive): a última pasta do computador escolhida para achar os originais ('' = nenhuma). */
  previaLocalDir: '',
  /** Sem receber/enviar nenhum byte por esse tempo, a conexão é refeita. */
  stallTimeoutMs: 30_000,
  /** Refaz conexões que ficaram muito mais lentas que as outras (o Google às vezes estrangula uma conexão). */
  restartSlowConnections: true,
  /** Mostrar arquivos ocultos no navegador local. */
  showHiddenFiles: false,
  /** 'system' | 'light' | 'dark' */
  theme: 'system',
  /** Aviso de versão nova: o build que a pessoa deixou para depois (0 = nenhum). Só um build mais novo avisa de novo. */
  versaoDispensada: 0,

  // ── Celular ──
  /**
   * Acompanhar pelo celular: com a conta SOBEDESCE, manda ao site o andamento das transferências deste computador
   * (nomes dos arquivos e progresso; src/engine/acompanhar.js). O app do celular mostra e avisa quando termina.
   */
  acompanharCelular: true,
  /** Recebe arquivos do celular pelo Wi-Fi (segundo servidor, aberto na rede local, protegido por código). */
  mobileReceive: false,
  /** Porta fixa: o QR code e o Atalho do iPhone guardam o endereço com ela. */
  mobilePort: 4319,
  // "Entre computadores" (docs/LAN.md): receber arquivos de outro computador da mesma conta pela rede local.
  lanReceber: false,
  // Aceitar pedidos de outras contas SOBEDESCE na mesma rede (sempre pergunta na tela antes de receber).
  lanOutros: false,
  lanPorta: 4320,
  lanPasta: path.join(os.homedir(), 'SOBEDESCE Recebidos'),
  // Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): o app do celular com a conta manda direto para este
  // computador (WebRTC na rede local). Fica só aqui, nesta pasta: não sobe pro Drive.
  celularReceber: true,
  // Aceitar de outras pessoas por perto (outra conta SOBEDESCE, mesma rede): sempre pergunta na tela antes de receber.
  celularOutros: false,
  celularPasta: path.join(os.homedir(), 'Downloads', 'SOBEDESCE do celular'),
  /** Onde os arquivos do celular ficam no computador antes (e, se quiser, depois) de subir. */
  mobileStagingDir: path.join(os.homedir(), 'SOBEDESCE Recebidos'),
  /** Apaga do computador o que veio do celular depois de subir e conferir no Drive. */
  mobileDeleteAfterUpload: false,
  /** Conta e pasta padrão do Drive para o que chega do celular ('' = primeira conta / Meu Drive). */
  mobileAccountId: '',
  mobileFolderId: '',
  mobileFolderName: '',
  /**
   * Obsoletos: o app do celular agora mora no site das contas (`<SOBEDESCE_CLOUD_URL>/app/`) e não usa client ID.
   * Ficam aceitos para não estragar ajustes salvos por versões antigas, mas não mudam mais nada.
   */
  mobileWebUrl: '',
  webClientId: '',
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
  mobilePort: [1024, 65535],
  lanPorta: [1024, 65535],
  versaoDispensada: [0, Number.MAX_SAFE_INTEGER],
}
const ENUMS = {
  downloadConflict: ['skip', 'rename', 'overwrite'],
  uploadConflict: ['skip', 'rename', 'replace'],
  theme: ['system', 'light', 'dark'],
  proxyAoEnviar: ['sempre', 'perguntar', 'nunca'],
}
const CHUNK_ALIGN = 256 * 1024

/** Endereço http(s) completo, sem credenciais embutidas. */
function isWebUrl(v) {
  try {
    const u = new URL(v)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}

/**
 * Textos que podem ficar vazios ('' = não definido). Cada um com a sua regra; fora dela = erro.
 * IDs do Google só têm letras, números, '_', '-' e '.' — nada que precise de escape em URL.
 */
const OPTIONAL_STRINGS = {
  mobileAccountId: v => /^(nuvem:)?[\w.-]{0,200}$/.test(v), // contas da nuvem: 'nuvem:<id>'
  mobileFolderId: v => /^[\w.-]{0,200}$/.test(v),
  mobileFolderName: v => v.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(v),
  rawThumbLocalDir: v => v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v),
  previaLocalDir: v => v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v),
  mobileWebUrl: v => v === '' || (v.length <= 2048 && isWebUrl(v)),
  webClientId: v => v === '' || /^[A-Za-z0-9][\w.-]*\.apps\.googleusercontent\.com$/.test(v),
}
const PATH_STRINGS = new Set(['downloadDir', 'mobileStagingDir', 'lanPasta', 'celularPasta'])

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
    } else if (OPTIONAL_STRINGS[key]) {
      const v = typeof value === 'string' ? value.trim() : value == null ? '' : null
      if (v == null || !OPTIONAL_STRINGS[key](v)) throw new Error(`Valor inválido para ${key}`)
      out[key] = v
    } else if (typeof def === 'string') {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Valor inválido para ${key}`)
      out[key] = PATH_STRINGS.has(key) ? path.resolve(value.trim()) : value.trim()
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
    // Campo por campo: um valor estragado (editado à mão, versão antiga) volta ao padrão sozinho,
    // sem levar junto a pasta de downloads, os limites e o resto do que a pessoa ajustou.
    let next = { ...DEFAULT_SETTINGS }
    const saved = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) }
    // Ajuste antigo (booleano) da prévia leve: vira a escolha de três opções.
    if (typeof saved.previaLeve === 'boolean' && saved.proxyAoEnviar === undefined) saved.proxyAoEnviar = saved.previaLeve ? 'sempre' : 'nunca'
    delete saved.previaLeve
    for (const [key, value] of Object.entries(saved)) {
      try {
        next = validateSettings({ [key]: value }, next)
      } catch {
        // fica o padrão deste campo
      }
    }
    this.current = next
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
