// Configuração do SOBEDESCE Celular: endpoints, modo de teste local, endereços da conta e ajustes.
// Os arquivos vão do navegador direto para o Google; o site da SOBEDESCE só entrega o token de acesso do Drive.

export const VERSION = '2.8.14'

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

// ───── modo de teste (só em 127.0.0.1/localhost) ─────
//
// ?dev_api=<base> aponta a API do Drive para um Drive falso (test/mock-drive.js com { cors: true }). A conta e o
// token continuam vindo do site (/api/eu e /api/drive/token), que o teste pode simular. Em qualquer outro host o
// parâmetro é ignorado: a checagem é do hostname da página, que o site publicado nunca tem. O próprio dev_api
// também precisa ser http em loopback.
function readDev() {
  if (!LOOPBACK.has(location.hostname)) return null
  const api = new URLSearchParams(location.search).get('dev_api')
  if (!api) return null
  let url
  try {
    url = new URL(api)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) return null
  return { api: url.origin + url.pathname.replace(/\/+$/, '') }
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

// ───── conta SOBEDESCE (mesmo site, cookie de sessão) ─────

export const APP_PATH = '/app/'
export const ACCOUNT = {
  me: '/api/eu',
  token: '/api/drive/token',
  signIn: `/entrar?volta=${APP_PATH}`,
  signUp: `/criar-conta?volta=${APP_PATH}`,
  manage: '/conta',
}

// ───── ajustes ─────

const SETTINGS_KEY = 'sobedesce.settings'
export const CONCURRENCY_OPTIONS = [1, 2, 3, 4]
export const CHUNK_OPTIONS = [4, 8, 16, 32] // MiB (múltiplos de 256 KiB, como o Google exige)
// 'auto': o pedaço acompanha a velocidade da rede (lib/uploader.js, chunkFor). É o padrão de quem nunca mexeu em
// Ajustes; quem já escolheu um tamanho (Rede do celular, Wi-Fi rápido) continua com o que escolheu.
export const CHUNK_AUTO = 'auto'
const DEFAULT_SETTINGS = { concurrency: 2, chunkMiB: CHUNK_AUTO }

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(local.get(SETTINGS_KEY) || {}) }
  if (!CONCURRENCY_OPTIONS.includes(s.concurrency)) s.concurrency = DEFAULT_SETTINGS.concurrency
  if (s.chunkMiB !== CHUNK_AUTO && !CHUNK_OPTIONS.includes(s.chunkMiB)) s.chunkMiB = DEFAULT_SETTINGS.chunkMiB
  return s
}

export function saveSettings(s) {
  local.set(SETTINGS_KEY, { concurrency: s.concurrency, chunkMiB: s.chunkMiB })
}
