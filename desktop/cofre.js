// Cofre do sistema no processo principal: o safeStorage do Electron (Keychain no Mac, DPAPI no Windows, keyring no Linux)
// só existe aqui, então o motor (utilityProcess) pede por mensagem (src/util/segredos.js, guardaPorMensagens).
// Sem depender do Electron (recebe o safeStorage), para dar para testar com node:test.

/**
 * A proteção vale a pena? No Linux sem keyring o Electron cai no 'basic_text' (senha fixa no código): isso não protege
 * nada, então conta como indisponível e os segredos seguem em arquivo 0600, como antes.
 */
export function cofreDisponivel(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage?.isEncryptionAvailable()) return false
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.()
      if (!backend || backend === 'basic_text' || backend === 'unknown') return false
    }
    return true
  } catch {
    return false
  }
}

/** Nome para a interface e o log ("Keychain do macOS"…), ou null sem cofre. */
export function nomeDoCofre(platform = process.platform) {
  if (platform === 'darwin') return 'Keychain do macOS'
  if (platform === 'win32') return 'proteção de dados do Windows'
  return 'chaveiro do sistema'
}

/**
 * Resposta a `{ type: 'cofre', id, op, dados }` (dados em base64). Nunca lança; nunca devolve o texto em claro no erro.
 * @returns {{ type: 'cofre-resposta', id, ok: boolean, disponivel?: boolean, dados?: string, erro?: string }}
 */
export function responderCofre(safeStorage, msg, { platform = process.platform } = {}) {
  const id = msg?.id
  const disponivel = cofreDisponivel(safeStorage, platform)
  if (msg?.op === 'estado') return { type: 'cofre-resposta', id, ok: true, disponivel }
  if (!disponivel) return { type: 'cofre-resposta', id, ok: false, erro: 'proteção do sistema indisponível' }
  if (typeof msg?.dados !== 'string' || msg.dados.length > 4 * 1024 * 1024) return { type: 'cofre-resposta', id, ok: false, erro: 'pedido inválido' }
  try {
    if (msg.op === 'cifrar') {
      const out = safeStorage.encryptString(Buffer.from(msg.dados, 'base64').toString('utf8'))
      return { type: 'cofre-resposta', id, ok: true, dados: Buffer.from(out).toString('base64') }
    }
    if (msg.op === 'decifrar') {
      const texto = safeStorage.decryptString(Buffer.from(msg.dados, 'base64'))
      return { type: 'cofre-resposta', id, ok: true, dados: Buffer.from(texto, 'utf8').toString('base64') }
    }
  } catch {
    return { type: 'cofre-resposta', id, ok: false, erro: msg.op === 'cifrar' ? 'não deu para cifrar' : 'não deu para decifrar' }
  }
  return { type: 'cofre-resposta', id, ok: false, erro: 'operação desconhecida' }
}
