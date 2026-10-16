// Referências: de que site é um link e se ele aponta para um vídeo/post que dá para salvar.
// Usado pelo motor (nome do arquivo, cookies que o yt-dlp precisa) e pelo navegador de referências do app de desktop
// (o botão "Salvar referência" só acende em página de vídeo/post). Sem dependências: o processo principal do
// Electron importa este arquivo direto.

/**
 * Plataformas conhecidas. `cookies`: domínios cujos cookies do navegador de referências vão para o yt-dlp
 * (só os do site do vídeo, nunca os de outros sites).
 */
export const PLATAFORMAS = Object.freeze({
  instagram: { nome: 'Instagram', hosts: /(^|\.)(instagram\.com|instagr\.am)$/, cookies: ['instagram.com'] },
  youtube: { nome: 'YouTube', hosts: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, cookies: ['youtube.com', 'google.com'] },
  tiktok: { nome: 'TikTok', hosts: /(^|\.)tiktok\.com$/, cookies: ['tiktok.com'] },
  vimeo: { nome: 'Vimeo', hosts: /(^|\.)vimeo\.com$/, cookies: ['vimeo.com'] },
  pinterest: { nome: 'Pinterest', hosts: /(^|\.)(pinterest\.[a-z]{2,3}(\.[a-z]{2})?|pin\.it)$/, cookies: ['pinterest.com'] },
  x: { nome: 'X', hosts: /(^|\.)(x\.com|twitter\.com)$/, cookies: ['x.com', 'twitter.com'] },
  facebook: { nome: 'Facebook', hosts: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/, cookies: ['facebook.com'] },
})

// Páginas de vídeo/post de cada plataforma (o caminho, depois de achar a plataforma pelo host).
const PADROES = {
  instagram: [/^\/(?:[\w.]+\/)?(?:reel|reels|p|tv)\/[\w-]{5,}\/?$/i],
  youtube: [/^\/watch\/?$/i, /^\/(?:shorts|live|embed|v)\/[\w-]{6,}\/?$/i],
  tiktok: [/^\/@[\w.-]+\/(?:video|photo)\/\d+\/?$/i, /^\/(?:t|v)\/[\w-]+\/?$/i],
  vimeo: [/^\/(?:\d+)(?:\/[\da-f]+)?\/?$/i, /^\/(?:channels\/[\w-]+|groups\/[\w-]+\/videos|album\/\d+\/video|showcase\/\d+\/video)\/\d+\/?$/i, /^\/video\/\d+\/?$/i],
  pinterest: [/^\/pin\/[\w-]+\/?$/i],
  x: [/^\/[\w]{1,20}\/status(?:es)?\/\d+(?:\/(?:video|photo)\/\d+)?\/?$/i, /^\/i\/(?:web\/)?status\/\d+\/?$/i],
  facebook: [/^\/(?:watch|reel)\/?(?:\d+\/?)?$/i, /^\/[\w.]+\/videos\/(?:[\w.-]+\/)?\d+\/?$/i, /^\/share\/[rv]\/[\w-]+\/?$/i],
}

/** host sem www./m. e em minúsculas ('' se a URL não for http/https). */
export function hostDe(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    return u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '')
  } catch {
    return ''
  }
}

/** Domínio "registrável" aproximado ('cdn.exemplo.com.br' → 'exemplo.com.br'), para os cookies de sites genéricos. */
export function dominioBase(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const segundo = parts[parts.length - 2]
  const curto = parts[parts.length - 1].length === 2 && /^(com|net|org|gov|edu|co|art|blog|tv|app)$/.test(segundo)
  return parts.slice(curto ? -3 : -2).join('.')
}

/**
 * De que plataforma é o link e se a página é um vídeo/post que dá para salvar.
 * @returns {{ plataforma: string, nome: string, salvavel: boolean, host: string }}
 *   `plataforma`: chave de PLATAFORMAS ou 'web'; `nome`: "Instagram", ou o domínio (sem www) quando é 'web'.
 */
export function detectar(url) {
  const host = hostDe(url)
  if (!host) return { plataforma: '', nome: '', salvavel: false, host: '' }
  let u
  try {
    u = new URL(String(url))
  } catch {
    return { plataforma: '', nome: '', salvavel: false, host: '' }
  }
  for (const [chave, p] of Object.entries(PLATAFORMAS)) {
    if (!p.hosts.test(host)) continue
    let salvavel = (PADROES[chave] || []).some(re => re.test(u.pathname))
    if (chave === 'youtube') {
      if (host === 'youtu.be') salvavel = /^\/[\w-]{6,}\/?$/.test(u.pathname)
      else if (/^\/watch\/?$/i.test(u.pathname)) salvavel = /^[\w-]{6,}$/.test(u.searchParams.get('v') || '')
    }
    if (chave === 'tiktok' && /^(vm|vt)\.tiktok\.com$/.test(host)) salvavel = /^\/[\w-]+\/?$/.test(u.pathname)
    if (chave === 'pinterest' && host === 'pin.it') salvavel = /^\/[\w-]+\/?$/.test(u.pathname)
    if (chave === 'vimeo' && host === 'player.vimeo.com') salvavel = /^\/video\/\d+/.test(u.pathname)
    if (chave === 'facebook' && host === 'fb.watch') salvavel = /^\/[\w-]+\/?$/.test(u.pathname)
    return { plataforma: chave, nome: p.nome, salvavel, host }
  }
  return { plataforma: 'web', nome: host, salvavel: false, host }
}

/** Nome bonito da plataforma ('instagram' → 'Instagram'); desconhecida = o próprio texto. */
export function nomeDaPlataforma(chave) {
  const v = String(chave || '').trim()
  return PLATAFORMAS[v.toLowerCase()]?.nome || v
}

/** Domínios cujos cookies o yt-dlp recebe para este link (vazio para link inválido). */
export function dominiosDeCookies(url) {
  const d = detectar(url)
  if (!d.plataforma) return []
  if (d.plataforma === 'web') return [dominioBase(d.host)].filter(Boolean)
  return [...PLATAFORMAS[d.plataforma].cookies]
}

// Parâmetros de rastreio que só atrapalham (o mesmo vídeo compartilhado duas vezes vira dois links).
const RASTREIO = /^(utm_[a-z]+|igsh|igshid|fbclid|gclid|si|feature|share_id|_r|_t|ref_src|ref_url|mibextid|is_from_webapp|sender_device)$/i

/**
 * Link pronto para salvar: http(s), sem credenciais, sem parâmetros de rastreio nem âncora, até 2048 caracteres.
 * Aceita texto com o link no meio ("Olha isso https://…"). null = inválido.
 */
export function limparUrl(entrada) {
  if (typeof entrada !== 'string') return null
  const m = /https?:\/\/[^\s<>"'`]+/i.exec(entrada)
  if (!m) return null
  let u
  try {
    u = new URL(m[0].replace(/[).,;!?\]}»”]+$/, ''))
  } catch {
    return null
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.') || u.username || u.password) return null
  for (const k of [...u.searchParams.keys()]) if (RASTREIO.test(k)) u.searchParams.delete(k)
  u.hash = ''
  const final = u.toString()
  return final.length <= 2048 ? final : null
}
