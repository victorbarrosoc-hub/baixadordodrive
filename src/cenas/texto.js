// Busca por cena: o texto que a pessoa digita vira números do mesmo jeito que o modelo foi treinado (tokenizador
// WordPiece do DistilBERT multilíngue, "cased"). Só o necessário para o modelo de texto (src/cenas/modelo.js):
//   normaliza (BertNormalizer: limpa controle, separa ideogramas; sem minúsculas, mantém acentos)
//   separa por espaço e pontuação (BertPreTokenizer)
//   quebra cada palavra nos pedaços do vocabulário, do maior para o menor (WordPiece, "##" na continuação)
//   [CLS] … [SEP]
// O vocabulário vem do tokenizer.json do modelo (baixado junto com ele).

const MAX_POR_PALAVRA = 100

const ehControle = (c) => {
  if (c === '\t' || c === '\n' || c === '\r') return false
  return /\p{Cc}|\p{Cf}/u.test(c)
}
const ehEspaco = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || /\p{Zs}/u.test(c)
// Pontuação no sentido do BERT: os blocos ASCII de símbolos e qualquer \p{P}.
const ehPontuacao = (c) => {
  const cp = c.codePointAt(0)
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return /\p{P}/u.test(c)
}
const ehIdeograma = (cp) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f)

/** BertNormalizer (clean_text + handle_chinese_chars, sem lowercase nem strip_accents). */
export function normalizar(texto) {
  let out = ''
  for (const c of String(texto ?? '')) {
    const cp = c.codePointAt(0)
    if (cp === 0 || cp === 0xfffd || ehControle(c)) continue
    if (ehEspaco(c)) out += ' '
    else if (ehIdeograma(cp)) out += ` ${c} `
    else out += c
  }
  return out
}

/** BertPreTokenizer: palavras separadas por espaço; cada pontuação vira uma palavra sozinha. */
export function separar(texto) {
  const palavras = []
  let atual = ''
  for (const c of texto) {
    if (ehEspaco(c)) {
      if (atual) palavras.push(atual)
      atual = ''
    } else if (ehPontuacao(c)) {
      if (atual) palavras.push(atual)
      palavras.push(c)
      atual = ''
    } else atual += c
  }
  if (atual) palavras.push(atual)
  return palavras
}

/**
 * @param {{ model: { vocab: Record<string, number>, unk_token?: string, continuing_subword_prefix?: string } }} json o tokenizer.json
 */
export function criarTokenizador(json) {
  const vocab = new Map(Object.entries(json?.model?.vocab || {}))
  if (!vocab.size) throw new Error('tokenizer.json sem vocabulário')
  const prefixo = json.model.continuing_subword_prefix ?? '##'
  const unk = vocab.get(json.model.unk_token || '[UNK]')
  const cls = vocab.get('[CLS]')
  const sep = vocab.get('[SEP]')

  const pedacos = (palavra) => {
    const cs = [...palavra]
    if (cs.length > MAX_POR_PALAVRA) return [unk]
    const ids = []
    let ini = 0
    while (ini < cs.length) {
      let fim = cs.length
      let achou = null
      while (ini < fim) {
        const sub = (ini > 0 ? prefixo : '') + cs.slice(ini, fim).join('')
        if (vocab.has(sub)) {
          achou = vocab.get(sub)
          break
        }
        fim--
      }
      if (achou == null) return [unk]
      ids.push(achou)
      ini = fim
    }
    return ids
  }

  return {
    /** Ids com [CLS] e [SEP], cortados em `max` (o modelo aceita 512; frases de busca ficam bem abaixo). */
    codificar(texto, max = 64) {
      const ids = [cls]
      for (const p of separar(normalizar(texto))) ids.push(...pedacos(p))
      ids.length = Math.min(ids.length, max - 1)
      ids.push(sep)
      return ids
    },
  }
}
