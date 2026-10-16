// Referências: nome do arquivo, appProperties e descrição que o app grava em cada item salvo no Drive
// (contrato em docs/ARCHITECTURE.md, "Referências"; o site lê a mesma descrição em web/src/lib/referencias/texto.ts).
//
//   nome:          "<Autor> - <Título curto> (<Plataforma>).mp4" (sem caracteres proibidos, até 120 caracteres)
//   appProperties: sobedesce=referencia, plataforma, autor, titulo, fonte — cada chave + valor até 124 bytes (UTF-8),
//                  o limite do Google (passar disso = 400 e o arquivo não sobe)
//   description:   1ª linha = link original completo; depois Título/Autor/Plataforma/Salvo em; linha em branco; nota e legenda
import { nomeDaPlataforma } from './plataformas.js'

export const MARCA = 'referencia' // appProperties.sobedesce
export const PROP_MAX_BYTES = 124 // chave + valor, em UTF-8
export const NOME_MAX = 120 // caracteres do nome do arquivo, com a extensão
const TITULO_CURTO = 60
const DESCRICAO_MAX = 16_000 // o Drive aceita mais, mas a descrição é para ler, não para guardar livro

const enc = new TextEncoder()
export const bytesUtf8 = s => enc.encode(String(s ?? '')).length

/** Corta `s` para caber em `max` bytes UTF-8 sem partir um caractere (nem um par de surrogates). */
export function cortarBytes(s, max) {
  const str = String(s ?? '')
  if (bytesUtf8(str) <= max) return str
  let out = ''
  let used = 0
  for (const ch of str) {
    const n = bytesUtf8(ch)
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

/** Texto de uma linha: sem controles, espaços juntos, NFC. */
export function umaLinha(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pedaço de nome de arquivo seguro no Drive e em qualquer disco (Mac/Windows): sem / \ : * ? " < > | e controles. */
export function limparNome(s) {
  return umaLinha(s)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .trim()
}

/** Corta em caracteres, de preferência num espaço, com "…" no fim. */
function encurtar(s, max) {
  const chars = [...s]
  if (chars.length <= max) return s
  const cut = chars.slice(0, max - 1).join('')
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`
}

/** Título de uma linha: a primeira linha, sem hashtags/menções no fim ("Plano na chuva #cinema #bts" → "Plano na chuva"). */
export function limparTitulo(titulo) {
  const primeira = umaLinha(String(titulo ?? '').split(/\r?\n/).find(l => l.trim()) || '')
  return primeira.replace(/(\s+[#@][\p{L}\p{N}_.]+)+$/u, '').trim() || primeira
}

/** Título curto para o nome: limparTitulo, sem caracteres proibidos, até 60 caracteres. */
export function tituloCurto(titulo) {
  return encurtar(limparNome(limparTitulo(titulo)), TITULO_CURTO)
}

/**
 * "<Autor> - <Título curto> (<Plataforma>).<ext>", até 120 caracteres. Falta autor → sem ele; falta título → o id.
 * @param {{ autor?: string, titulo?: string, plataforma?: string, id?: string, ext?: string }} p
 */
export function nomeDoArquivo({ autor, titulo, plataforma, id, ext = 'mp4' } = {}) {
  const e = String(ext || 'mp4').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4'
  const plat = limparNome(nomeDaPlataforma(plataforma)) || 'Web'
  const a = encurtar(limparNome(autor), 40)
  let t = tituloCurto(titulo)
  if (!t || (a && t.toLowerCase() === a.toLowerCase())) t = limparNome(id) || ''
  if (!t && !a) t = 'Referência'
  const sufixo = ` (${plat}).${e}`
  const cabe = NOME_MAX - [...sufixo].length
  let base = a && t ? `${a} - ${t}` : a || t
  if ([...base].length > cabe) base = encurtar(base, cabe)
  return `${base}${sufixo}`
}

function prop(out, chave, valor) {
  const v = cortarBytes(umaLinha(valor), PROP_MAX_BYTES - bytesUtf8(chave))
  if (v) out[chave] = v
}

/** Link cortado para caber: corta a query primeiro (o link inteiro fica na descrição). */
function fonteCurta(url, max) {
  const s = String(url ?? '')
  if (bytesUtf8(s) <= max) return s
  try {
    const u = new URL(s)
    const semQuery = `${u.origin}${u.pathname}`
    if (bytesUtf8(semQuery) <= max) return semQuery
  } catch {}
  return cortarBytes(s, max)
}

/**
 * appProperties de um item salvo. Cada chave + valor cabe em 124 bytes UTF-8.
 * @param {{ url: string, plataforma?: string, autor?: string, titulo?: string }} r
 */
export function appProperties({ url, plataforma, autor, titulo, fila } = {}) {
  const out = { sobedesce: MARCA }
  if (fila) prop(out, 'fila', fila)
  prop(out, 'plataforma', nomeDaPlataforma(plataforma))
  prop(out, 'autor', autor)
  prop(out, 'titulo', titulo)
  const fonte = fonteCurta(umaLinha(url), PROP_MAX_BYTES - bytesUtf8('fonte'))
  if (fonte) out.fonte = fonte
  return out
}

/**
 * Descrição do arquivo no Drive (o site e o "Link pra IA" leem isto):
 *   <link original completo>
 *   Título: …
 *   Autor: …
 *   Plataforma: …
 *   Salvo em: <ISO>
 *   (linha em branco)
 *   <legenda>
 *   (linha em branco)
 *   Nota: …        (se houver)
 */
export function descricao({ url, titulo, autor, plataforma, salvoEm = new Date(), nota, legenda } = {}) {
  const linhas = [umaLinha(url)]
  const t = umaLinha(titulo)
  const a = umaLinha(autor)
  const p = umaLinha(nomeDaPlataforma(plataforma))
  if (t) linhas.push(`Título: ${t}`)
  if (a) linhas.push(`Autor: ${a}`)
  if (p) linhas.push(`Plataforma: ${p}`)
  linhas.push(`Salvo em: ${new Date(salvoEm).toISOString()}`)
  const corpo = []
  const n = String(nota ?? '').replace(/\r\n?/g, '\n').trim()
  const l = String(legenda ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (l) corpo.push(l)
  if (n) corpo.push(`Nota: ${n}`)
  const texto = corpo.length ? `${linhas.join('\n')}\n\n${corpo.join('\n\n')}` : linhas.join('\n')
  return texto.length > DESCRICAO_MAX ? `${texto.slice(0, DESCRICAO_MAX - 1)}…` : texto
}

const CAMPOS = { 'título': 'titulo', titulo: 'titulo', autor: 'autor', plataforma: 'plataforma', 'salvo em': 'salvoEm' }

/**
 * Lê de volta o que o app gravou (para a tela de Referências). Qualquer parte pode faltar.
 * @returns {{ url: string|null, titulo: string|null, autor: string|null, plataforma: string|null, salvoEm: string|null,
 *   nota: string|null, legenda: string }}
 */
export function lerReferencia({ description, appProperties: props } = {}) {
  const out = { url: null, titulo: null, autor: null, plataforma: null, salvoEm: null, nota: null, legenda: '' }
  const linhas = String(description ?? '').replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < linhas.length && !linhas[i].trim()) i++
  if (/^https?:\/\/\S+$/i.test(linhas[i]?.trim() || '')) out.url = linhas[i++].trim()
  for (; i < linhas.length; i++) {
    const l = linhas[i]
    if (!l.trim()) {
      i++
      break
    }
    const m = /^\s*([^:]{2,20}):\s*(.*)$/.exec(l)
    const k = m ? CAMPOS[m[1].trim().toLowerCase()] : null
    if (!k) break
    if (m[2].trim()) out[k] = m[2].trim()
  }
  let resto = linhas.slice(i).join('\n').trim()
  // A nota da pessoa é o último parágrafo, "Nota: …" (versões antigas punham antes da legenda: aceita os dois).
  const fim = /(?:^|\n\n)Nota:\s*([^\n]*(?:\n(?!\n)[^\n]*)*)\s*$/.exec(resto)
  const comeco = !fim && /^Nota:\s*([\s\S]*?)(?:\n\n|$)/.exec(resto)
  if (fim) {
    out.nota = fim[1].trim() || null
    resto = resto.slice(0, fim.index).trim()
  } else if (comeco) {
    out.nota = comeco[1].trim() || null
    resto = resto.slice(comeco[0].length).trim()
  }
  out.legenda = resto
  const p = props && typeof props === 'object' ? props : {}
  out.url ??= typeof p.fonte === 'string' && /^https?:\/\//i.test(p.fonte) ? p.fonte : null
  out.titulo ??= typeof p.titulo === 'string' ? p.titulo : null
  out.autor ??= typeof p.autor === 'string' ? p.autor : null
  out.plataforma ??= typeof p.plataforma === 'string' ? p.plataforma : null
  return out
}

/** O item do Drive foi salvo pelas Referências? */
export const ehReferencia = item => item?.appProperties?.sobedesce === MARCA
