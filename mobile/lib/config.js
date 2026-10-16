// Configuração do SOBEDESCE Celular: endpoints, modo de teste local, ID do cliente e ajustes.
// Tudo aqui roda no navegador; não existe servidor nosso no caminho dos arquivos.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
export const VERSION = '1.0.0'

const LOOPBACK = new Set(['127.0.0.1', 'localhost'])

// ───── armazenamento seguro (Safari em modo privado pode lançar exceção) ─────

export const local = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // sem espaço ou bloqueado: segue só em memória
    }
  },
}

export const session = {
  get(key) {
    try {
      const raw = sessionStorage.getItem(key)
      return raw == null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      if (value == null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // idem
    }
  },
}

// ───── modo de teste (só em 127.0.0.1/localhost) ─────
//
// ?dev_api=<base>&dev_token=<token> aponta a API para um Drive falso e pula o login do Google.
// Em qualquer outro host estes parâmetros são ignorados: a checagem é do hostname da página, que o site
// publicado nunca tem. O próprio dev_api também precisa ser http em loopback.
function readDev() {
  if (!LOOPBACK.has(location.hostname)) return null
  const params = new URLSearchParams(location.search)
  const api = params.get('dev_api')
  const token = params.get('dev_token')
  if (!api || !token) return null
  let url
  try {
    url = new URL(api)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return null
  return { api: url.origin + url.pathname.replace(/\/+$/, ''), token }
}

export const DEV = readDev()

// ───── modo Wi-Fi ("via computador") ─────
//
// Servido pelo SOBEDESCE do computador (src/mobile/receiver.js), o index.html carrega antes o lan-config.js, que
// define window.__SOBEDESCE_LAN__ = { mode: 'lan', code, mac, platform }. Aí não há login do Google no celular: os
// arquivos vão em pedaços para o computador, que sobe pro Drive. No site publicado isso nunca existe.
function readLan() {
  try {
    const cfg = window.__SOBEDESCE_LAN__
    if (!cfg || cfg.mode !== 'lan' || typeof cfg.code !== 'string' || !cfg.code) return null
    return { code: cfg.code, mac: String(cfg.mac || 'computador'), label: cfg.platform === 'win32' ? 'PC' : 'Mac' }
  } catch {
    return null
  }
}

export const LAN = readLan()

export const ENDPOINTS = DEV
  ? { api: `${DEV.api}/drive/v3`, upload: `${DEV.api}/upload/drive/v3` }
  : { api: 'https://www.googleapis.com/drive/v3', upload: 'https://www.googleapis.com/upload/drive/v3' }

// ───── ID do cliente OAuth (tipo "Aplicativo da Web") ─────

const CLIENT_KEY = 'sobedesce.clientId'
const CLIENT_RE = /[A-Za-z0-9][\w.-]*\.apps\.googleusercontent\.com/

/** Acha um ID de cliente num texto colado (aceita o ID puro, com espaços, ou até o JSON inteiro). */
export function extractClientId(text) {
  const m = CLIENT_RE.exec(String(text || '').trim())
  return m ? m[0] : null
}

// ID público (não é segredo) do cliente "SOBEDESCE Celular" do projeto Google do Victor.
// Vale só no endereço oficial; em outro domínio a tela de configurar continua pedindo o ID.
const OFFICIAL_HOST = 'sobedesce.vercel.app'
const OFFICIAL_CLIENT_ID = '235961238964-e87vitlplbrnu5kb3vsfms7tjgt98q4b.apps.googleusercontent.com'

export function getClientId() {
  return local.get(CLIENT_KEY) || (location.hostname === OFFICIAL_HOST ? OFFICIAL_CLIENT_ID : null)
}

export function saveClientId(id) {
  local.set(CLIENT_KEY, id || null)
}

/**
 * ?client_id=… (vindo do QR code do app do computador): guarda e tira da barra de endereço.
 * Devolve o ID aceito, ou null.
 */
export function consumeClientIdParam() {
  const url = new URL(location.href)
  const raw = url.searchParams.get('client_id')
  if (raw == null) return null
  url.searchParams.delete('client_id')
  try {
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash)
  } catch {
    // alguns navegadores embutidos bloqueiam; o ID já foi lido
  }
  const id = extractClientId(raw)
  if (id && id === raw.trim()) {
    saveClientId(id)
    return id
  }
  return null
}

// ───── ajustes ─────

const SETTINGS_KEY = 'sobedesce.settings'
export const CONCURRENCY_OPTIONS = [1, 2, 3, 4]
export const CHUNK_OPTIONS = [4, 8, 16, 32] // MiB (múltiplos de 256 KiB, como o Google exige)
const DEFAULT_SETTINGS = { concurrency: 2, chunkMiB: 8 }

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(local.get(SETTINGS_KEY) || {}) }
  if (!CONCURRENCY_OPTIONS.includes(s.concurrency)) s.concurrency = DEFAULT_SETTINGS.concurrency
  if (!CHUNK_OPTIONS.includes(s.chunkMiB)) s.chunkMiB = DEFAULT_SETTINGS.chunkMiB
  return s
}

export function saveSettings(s) {
  local.set(SETTINGS_KEY, { concurrency: s.concurrency, chunkMiB: s.chunkMiB })
}
