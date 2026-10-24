// A abertura (lib/abertura.js) é o mesmo arquivo no app do computador e no do celular: os dois não podem divergir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ler = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('abertura: o arquivo do computador e o do celular são iguais', () => {
  assert.equal(ler('../web/public/app/lib/abertura.js'), ler('../public/lib/abertura.js'))
})

test('abertura: os dois apps chamam a abertura antes de desenhar a tela, e o celular guarda o arquivo para abrir sem rede', () => {
  const pc = ler('../public/app.js')
  const cel = ler('../web/public/app/app.js')
  assert.ok(pc.indexOf('abertura({') > 0 && pc.indexOf('abertura({') < pc.indexOf('render(html'))
  assert.ok(cel.indexOf('abertura({') > 0 && cel.indexOf('abertura({') < cel.indexOf('render(html'))
  assert.match(ler('../web/public/app/sw.js'), /'\.\/lib\/abertura\.js'/)
})

test('abertura: o visual vem de lib/abertura.css ligado no index.html (o site do celular não aceita <style> criado pelo código)', () => {
  assert.equal(ler('../web/public/app/lib/abertura.css'), ler('../public/lib/abertura.css'))
  assert.match(ler('../public/lib/abertura.css'), /\.ab-camada\{position:fixed/)
  assert.doesNotMatch(ler('../public/lib/abertura.js'), /['"]style['"]/)
  assert.match(ler('../web/public/app/index.html'), /<link rel="stylesheet" href="lib\/abertura\.css" \/>/)
  assert.match(ler('../public/index.html'), /<link rel="stylesheet" href="\/lib\/abertura\.css" \/>/)
  assert.match(ler('../web/public/app/sw.js'), /'\.\/lib\/abertura\.css'/)
})
