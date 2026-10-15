// Detecções de plataforma (só para dicas na tela; nada de comportamento depende disso).

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''

export const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)

/** Safari de verdade no iOS (Chrome/Firefox/Edge do iOS têm o botão Compartilhar em outro lugar). */
export const isIOSSafari = isIOS && /Safari\//.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo)\//.test(ua)

export function isStandalone() {
  try {
    return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
  } catch {
    return false
  }
}
