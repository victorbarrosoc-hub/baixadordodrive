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
