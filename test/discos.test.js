// Copiar entre discos (src/discos/): cópia de um arquivo para vários destinos com MD5, cancelamento sem deixar lixo,
// comparação antes de copiar e o serviço de ponta a ponta (progresso, relatório .md5, substituir, espaço).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { BLOCO, CopiaCancelada, PARCIAL, copiarArquivo } from '../src/discos/copiar.js'
import { planejar, nomeDePasta, nomePadrao } from '../src/discos/planejar.js'
import { DiscosService } from '../src/discos/servico.js'
import { makeTmpDir } from './helpers.js'

const tmp = async (t) => {
  const d = await makeTmpDir('sobedesce-discos-')
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')
async function escrever(arq, buf, mtime) {
  await fsp.mkdir(path.dirname(arq), { recursive: true })
  await fsp.writeFile(arq, buf)
  if (mtime) await fsp.utimes(arq, mtime, mtime)
}
const esperar = async (svc, fases = ['feito', 'erro', 'cancelado']) => {
  for (let i = 0; i < 400 && !fases.includes(svc.fase); i++) await new Promise((ok) => setTimeout(ok, 25))
  return svc.view()
}
const semDormir = { setActive() {} }

describe('copiar entre discos', () => {
  test('um arquivo para dois destinos: mesmo conteúdo, MD5, data mantida e nada de parcial', async (t) => {
    const dir = await tmp(t)
    const dados = crypto.randomBytes(BLOCO * 2 + 12345)
    const data = new Date('2024-05-01T10:00:00Z')
    await escrever(path.join(dir, 'cartao', 'A001.MP4'), dados, data)
    const destinos = [path.join(dir, 'ssd1', 'Proj', 'A001.MP4'), path.join(dir, 'ssd2', 'Proj', 'A001.MP4')]
    let copiando = 0
    let conferindo = 0
    const r = await copiarArquivo({
      origem: path.join(dir, 'cartao', 'A001.MP4'),
      destinos,
      mtimeMs: data.getTime(),
      onBytes: (n, fase) => (fase === 'copiando' ? (copiando += n) : (conferindo += n)),
    })
    assert.equal(r.md5, md5(dados))
    assert.equal(r.bytes, dados.length)
    assert.deepEqual(r.destinos.map((d) => d.ok), [true, true])
    assert.equal(copiando, dados.length)
    assert.ok(Math.abs(conferindo - dados.length) < 2, 'conferência conta o tamanho uma vez (dividido entre os destinos)')
    for (const d of destinos) {
      assert.ok((await fsp.readFile(d)).equals(dados))
      assert.equal((await fsp.stat(d)).mtimeMs, data.getTime())
      assert.equal(fs.existsSync(d + PARCIAL), false)
    }
  })

  test('cancelar no meio apaga os parciais e não cria o arquivo final', async (t) => {
    const dir = await tmp(t)
    await escrever(path.join(dir, 'o.bin'), crypto.randomBytes(BLOCO * 3))
    let blocos = 0
    const destino = path.join(dir, 'd', 'o.bin')
    await assert.rejects(
      copiarArquivo({ origem: path.join(dir, 'o.bin'), destinos: [destino], parar: () => blocos >= 1, onBytes: () => blocos++ }),
      (err) => err instanceof CopiaCancelada,
    )
    assert.deepEqual(await fsp.readdir(path.join(dir, 'd')), [])
  })

  test('nome da pasta no destino: limpo, e o padrão vem da origem', () => {
    assert.equal(nomeDePasta('  Casamento / Ana: Leo  '), 'Casamento Ana Leo')
    assert.equal(nomeDePasta('../..'), null)
    assert.equal(nomePadrao('/Volumes/A7SIII_01'), 'A7SIII_01')
  })

  test('planejar: novo, igual, diferente por destino; pastas de sistema ficam de fora; destino dentro da origem não', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'CARD')
    await escrever(path.join(org, 'PRIVATE', 'M4ROOT', 'CLIP', 'C0001.MP4'), Buffer.alloc(1000, 1))
    await escrever(path.join(org, 'PRIVATE', 'M4ROOT', 'CLIP', 'C0002.MP4'), Buffer.alloc(2000, 2))
    await escrever(path.join(org, 'C0003.MP4'), Buffer.alloc(3000, 3))
    await escrever(path.join(org, '.Spotlight-V100', 'Store-V2', 'x'), Buffer.alloc(10))
    await escrever(path.join(dir, 'SSD', 'CARD', 'PRIVATE', 'M4ROOT', 'CLIP', 'C0001.MP4'), Buffer.alloc(1000, 9)) // mesmo tamanho
    await escrever(path.join(dir, 'SSD', 'CARD', 'C0003.MP4'), Buffer.alloc(10, 3)) // tamanho diferente
    await fsp.mkdir(path.join(dir, 'SSD2'))
    const p = await planejar({ origem: org, destinos: [path.join(dir, 'SSD'), path.join(dir, 'SSD2')] })
    assert.equal(p.nome, 'CARD')
    assert.equal(p.origem.arquivos, 3, 'sem .Spotlight-V100')
    assert.equal(p.origem.bytes, 6000)
    const [a, b] = p.destinos
    assert.deepEqual([a.novos, a.iguais, a.diferentes, a.bytesNovos], [1, 1, 1, 2000])
    assert.deepEqual([b.novos, b.iguais, b.diferentes], [3, 0, 0])
    assert.ok(a.livre == null || a.livre > 0)
    await assert.rejects(planejar({ origem: org, destinos: [path.join(org, 'PRIVATE')] }), /dentro da origem/)
    await assert.rejects(planejar({ origem: org, destinos: [path.join(dir, 'nao-existe')] }), /não está acessível/)
    await assert.rejects(planejar({ origem: org, destinos: [path.join(dir, 'SSD'), path.join(dir, 'SSD') + path.sep] }), /duas vezes/)
  })

  test('serviço: compara, copia para dois SSDs com conferência, mostra velocidade e grava o relatório .md5', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'A7S_CARD')
    const arquivos = { 'CLIP/C0001.MP4': crypto.randomBytes(BLOCO + 7), 'CLIP/C0002.MP4': crypto.randomBytes(300_000), 'Áudio/Zoom 01.WAV': crypto.randomBytes(50_000) }
    for (const [rel, buf] of Object.entries(arquivos)) await escrever(path.join(org, ...rel.split('/')), buf)
    const ssd1 = path.join(dir, 'SSD1')
    const ssd2 = path.join(dir, 'SSD2')
    await fsp.mkdir(ssd1)
    await fsp.mkdir(ssd2)
    const avisos = []
    let acordado = []
    const svc = new DiscosService({ onChange: (v) => avisos.push(v), keepAwake: { setActive: (on) => acordado.push(on) } })
    t.after(() => svc.close())

    const v = await svc.planejar({ origem: org, destinos: [ssd1, ssd2], nome: 'Casamento Ana · Cam A' })
    assert.equal(v.fase, 'pronto')
    assert.equal(v.plano.nome, 'Casamento Ana · Cam A')
    assert.deepEqual(v.plano.destinos.map((d) => d.novos), [3, 3])
    assert.equal(svc.itens({ estado: 'novo' }).total, 3)

    await svc.iniciar({ conferir: true, relatorio: true })
    const fim = await esperar(svc)
    assert.equal(fim.fase, 'feito', fim.erro)
    assert.equal(fim.resultado.copiados, 3)
    assert.equal(fim.resultado.gravacoes, 6)
    assert.deepEqual(fim.resultado.falhas, [])
    assert.deepEqual(acordado, [true, false], 'o computador não dorme durante a cópia')
    const total = Object.values(arquivos).reduce((s, b) => s + b.length, 0)
    assert.equal(fim.progresso.copiados, total)
    assert.equal(fim.progresso.conferidos, total)
    assert.equal(fim.progresso.restante, 0)
    assert.ok(fim.progresso.velocidadeMedia > 0)
    assert.ok(avisos.some((a) => a.fase === 'copiando' && a.progresso), 'avisou o andamento')

    for (const ssd of [ssd1, ssd2]) {
      const pasta = path.join(ssd, 'Casamento Ana · Cam A')
      for (const [rel, buf] of Object.entries(arquivos)) assert.ok((await fsp.readFile(path.join(pasta, ...rel.split('/')))).equals(buf), rel)
      const rel = (await fsp.readdir(pasta)).find((n) => /^SOBEDESCE_copia_.*\.md5$/.test(n))
      assert.ok(rel, 'relatório no destino')
      const linhas = (await fsp.readFile(path.join(pasta, rel), 'utf8')).trim().split('\n').sort()
      assert.deepEqual(linhas, Object.entries(arquivos).map(([r, b]) => `${md5(b)}  ${r}`).sort())
    }

    // De novo: tudo igual, nada a copiar.
    const v2 = await svc.planejar({ origem: org, destinos: [ssd1, ssd2], nome: 'Casamento Ana · Cam A' })
    assert.deepEqual(v2.plano.destinos.map((d) => d.iguais), [3, 3])
  })

  test('serviço: diferente só é substituído quando pedido; espaço insuficiente não começa', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'CARD')
    await escrever(path.join(org, 'A.MOV'), Buffer.alloc(5000, 7))
    await escrever(path.join(dir, 'SSD', 'CARD', 'A.MOV'), Buffer.alloc(10, 1))
    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())

    await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    svc.plano.destinos[0].livre = 100
    await assert.rejects(svc.iniciar({ substituir: true }), /Não cabe/)

    await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    await svc.iniciar({ substituir: false })
    let fim = await esperar(svc)
    assert.equal(fim.progresso.totalArquivos, 0)
    assert.equal((await fsp.stat(path.join(dir, 'SSD', 'CARD', 'A.MOV'))).size, 10, 'sem pedir, não mexe')

    await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    await svc.iniciar({ substituir: true, relatorio: false })
    fim = await esperar(svc)
    assert.equal(fim.fase, 'feito')
    assert.equal((await fsp.stat(path.join(dir, 'SSD', 'CARD', 'A.MOV'))).size, 5000)
    assert.equal((await fsp.readdir(path.join(dir, 'SSD', 'CARD'))).some((n) => n.endsWith('.md5')), false)
  })

  test('serviço: cancelar no meio para logo e não deixa parcial', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'CARD')
    for (let i = 0; i < 6; i++) await escrever(path.join(org, `C${i}.MP4`), crypto.randomBytes(BLOCO * 2))
    await fsp.mkdir(path.join(dir, 'SSD'))
    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())
    await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    await svc.iniciar({})
    for (let i = 0; i < 200 && !(svc.prog.copiados > 0); i++) await new Promise((ok) => setTimeout(ok, 5))
    svc.cancelar()
    const fim = await esperar(svc)
    assert.equal(fim.fase, 'cancelado')
    const ficou = await fsp.readdir(path.join(dir, 'SSD', 'CARD')).catch(() => [])
    assert.equal(ficou.filter((n) => n.endsWith(PARCIAL)).length, 0)
    assert.ok(ficou.length < 6)
  })
})
