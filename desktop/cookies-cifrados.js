// Cookies cifrados (fusível EnableCookieEncryption, electron-builder.yml). Com o fusível ligado, o Chromium grava os
// cookies novos cifrados com a chave do sistema (Keychain/DPAPI), mas os que já estavam no disco continuariam em texto
// puro até o site trocá-los (a sessão do Instagram dura meses). Por isso, na primeira abertura do app empacotado com o
// fusível, os cookies antigos do navegador de Referências são apagados antes de a sessão dele ser usada: a pessoa entra
// de novo no Instagram uma vez e, dali em diante, tudo fica cifrado. A janela principal não guarda login em cookie.
// Sem depender do Electron (recebe a pasta), para dar para testar com node:test.
import fs from 'node:fs'
import path from 'node:path'

const MARCA = 'cookies-cifrados.json'
const VERSAO = 1

// Onde o Chromium guarda os cookies da partição 'persist:navegador' (versões novas em Network/, antigas na raiz).
const ARQUIVOS = ['Cookies', 'Cookies-journal', path.join('Network', 'Cookies'), path.join('Network', 'Cookies-journal')]

const lerMarca = userData => {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, MARCA), 'utf8'))
  } catch {
    return null
  }
}

const gravarMarca = (userData, dados) => {
  try {
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(path.join(userData, MARCA), JSON.stringify(dados), { mode: 0o600 })
  } catch {}
}

/**
 * Apaga uma vez os cookies em texto puro da partição do navegador. Chamar antes de qualquer `session.fromPartition`.
 * @param {{ userData: string, ligado: boolean, particao?: string }} o `ligado`: o fusível vale neste executável
 *   (app empacotado; no `npm run desktop` o Electron de desenvolvimento não tem o fusível e nada muda).
 * @returns {{ apagou: boolean }} `apagou`: havia cookies (a pessoa precisa entrar de novo uma vez).
 */
export function migrarCookies({ userData, ligado, particao = 'navegador' }) {
  if (!ligado || !userData) return { apagou: false }
  if (lerMarca(userData)?.versao >= VERSAO) return { apagou: false }
  const base = path.join(userData, 'Partitions', particao)
  let apagou = false
  for (const rel of ARQUIVOS) {
    const file = path.join(base, rel)
    try {
      if (!fs.existsSync(file)) continue
      fs.rmSync(file, { force: true })
      if (!rel.endsWith('-journal')) apagou = true
    } catch {}
  }
  gravarMarca(userData, { versao: VERSAO, em: Date.now(), avisar: apagou })
  return { apagou }
}

/** Ainda falta avisar "Entre de novo no Instagram uma vez"? */
export function precisaAvisar(userData) {
  const m = lerMarca(userData)
  return Boolean(m?.avisar && !m.avisadoEm)
}

/** O aviso já apareceu (não repete). */
export function marcarAvisado(userData) {
  const m = lerMarca(userData)
  if (m) gravarMarca(userData, { ...m, avisadoEm: Date.now() })
}

export const AVISO_COOKIES = {
  titulo: 'Entre de novo no Instagram uma vez',
  texto:
    'Por segurança, os logins do navegador de referências agora ficam cifrados com a proteção do sistema. ' +
    'Os antigos foram apagados: entre de novo no Instagram (e nos outros sites) uma vez e pronto.',
}
