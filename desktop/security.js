// Regras de confiança do app de desktop, sem depender do Electron (assim dá para testar com node:test).
// A janela só mostra a interface do motor (http://127.0.0.1:<porta>); qualquer outra origem que por algum motivo
// chegasse a rodar ali (link, redirecionamento, iframe) não pode usar a ponte nativa nem pedir permissões.

/** A URL é da interface do motor (mesma origem)? */
export function isAppUrl(url, origin) {
  if (!url || !origin) return false
  try {
    return new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/** Mensagem da ponte (ipcMain) veio da página do app, do quadro principal? */
export function trustedSender(event, origin) {
  const frame = event?.senderFrame
  if (!frame || frame.parent) return false // só o quadro principal (nada de iframe)
  return isAppUrl(frame.url, origin)
}

// A interface só precisa copiar texto (endereços do celular). Câmera, microfone, localização, notificações da web etc.
// ficam negados; as notificações do app passam pela ponte nativa.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

export function allowPermission(permission, requestingUrl, origin) {
  return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, origin)
}

// ─────────── navegador de referências (desktop/navegador.js) ───────────
// A página de sites de terceiros (Instagram, YouTube…) roda numa sessão separada ('persist:navegador'), sem preload e
// sem ponte nenhuma. Ela nunca pode alcançar o motor (127.0.0.1:<porta>), a recepção do celular nem qualquer outro
// serviço desta máquina: toda requisição para loopback/localhost é cancelada, e só http(s) navega.

export const NAVEGADOR_PARTICAO = 'persist:navegador'

/** Host de loopback/"esta máquina" (127.0.0.0/8, ::1, localhost, *.localhost, 0.0.0.0). */
export function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::' || h === '0.0.0.0') return true
  if (/^::ffff:(127\.|0\.0\.0\.0)/.test(h)) return true
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true
  // 0x7f000001, 2130706433 e afins: o Chromium normaliza para 127.0.0.1, mas recusamos também a forma crua.
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) {
    const n = Number(h)
    if (Number.isFinite(n) && n >= 0x7f000000 && n <= 0x7fffffff) return true
  }
  return false
}

/** Requisição que a página do navegador de referências NÃO pode fazer (motor local, file:, esquemas internos). */
export function bloqueadoNoNavegador(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return true
  }
  const okScheme = ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'].includes(u.protocol)
  if (!okScheme) return true
  if (u.protocol === 'data:' || u.protocol === 'blob:') return false
  return isLoopbackHost(u.hostname)
}

/** Para onde a página principal do navegador pode ir (só http/https e nunca esta máquina). */
export function podeNavegar(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !isLoopbackHost(u.hostname) && !u.username && !u.password
  } catch {
    return false
  }
}

// Sites de vídeo pedem tela cheia; todo o resto (câmera, microfone, localização, notificações…) fica negado.
const NAVEGADOR_PERMISSOES = new Set(['fullscreen'])

export function permissaoNoNavegador(permission) {
  return NAVEGADOR_PERMISSOES.has(permission)
}

/**
 * Texto da barra de endereço → URL para abrir. Sem esquema: domínio vira https://; outra coisa vira busca.
 * null = não dá (ex.: endereço desta máquina).
 */
export function enderecoDigitado(texto) {
  const t = String(texto || '').trim()
  if (!t) return null
  let url
  if (/^https?:\/\//i.test(t)) url = t
  else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(t) && !/\s/.test(t)) url = `https://${t}`
  else url = `https://www.google.com/search?q=${encodeURIComponent(t)}`
  return podeNavegar(url) ? new URL(url).href : null
}

/** Domínios que o motor pode pedir cookies (só nomes de domínio simples; nada de IP, curinga ou localhost). */
export function dominiosValidos(lista) {
  if (!Array.isArray(lista)) return []
  return [...new Set(lista.filter(d => typeof d === 'string' && /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(d) && !isLoopbackHost(d)).map(d => d.toLowerCase()))].slice(0, 6)
}
