// CSS do app do computador e do celular: chaves fechadas. Uma chave faltando no fim de um @media prende todo o resto
// do arquivo dentro dele (foi assim que a tela Cartões ficou sem estilo, só com "reduzir movimento" ligado).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const ARQUIVOS = ['../public/styles.css', '../web/public/app/app.css']

/** Profundidade das chaves, ignorando comentários e textos entre aspas. Devolve a linha do primeiro erro. */
function conferir(css) {
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (c) => c.replace(/[^\n]/g, ' '))
  let d = 0
  let linha = 1
  let abriu = []
  for (const ch of limpo) {
    if (ch === '\n') linha++
    else if (ch === '{') abriu.push(linha), d++
    else if (ch === '}') {
      d--
      abriu.pop()
      if (d < 0) return { erro: `"}" sobrando na linha ${linha}` }
    }
  }
  return d ? { erro: `${d} chave(s) sem fechar; a última aberta na linha ${abriu.at(-1)}` } : { ok: true }
}

test('CSS: todas as chaves fecham (computador e celular)', async () => {
  for (const a of ARQUIVOS) {
    const r = conferir(await fs.readFile(new URL(a, import.meta.url), 'utf8'))
    assert.ok(r.ok, `${a}: ${r.erro}`)
  }
  assert.ok(conferir('@media (x) { a { b: c; }').erro, 'pega o @media sem fechar')
})
