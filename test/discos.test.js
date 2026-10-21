// Copiar entre discos (src/discos/): cópia de um arquivo para vários destinos com checksum (xxHash64 ou MD5), cancelamento
// sem deixar lixo, comparação antes de copiar e o serviço de ponta a ponta (progresso, relatório, substituir, espaço,
// muitos arquivos pequenos ao mesmo tempo).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { BLOCO, CopiaCancelada, PARCIAL, copiarArquivo, criarHash } from '../src/discos/copiar.js'
import { planejar, nomeDePasta, nomePadrao } from '../src/discos/planejar.js'
import { DiscosService } from '../src/discos/servico.js'
import { registerDiscos } from '../src/server/discos.js'
import { makeTmpDir } from './helpers.js'

const tmp = async (t) => {
  const d = await makeTmpDir('sobedesce-discos-')
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')
const xxh64 = async (buf) => {
  const h = await criarHash('xxh64')
  h.update(buf)
  return h.hex()
}
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
  test('xxHash64 bate com os valores oficiais', async () => {
    assert.equal(await xxh64(Buffer.from('')), 'ef46db3751d8e999')
    assert.equal(await xxh64(Buffer.from('abc')), '44bc2cf5ad770999')
  })

  test('um arquivo para dois destinos: mesmo conteúdo, checksum, data mantida e nada de parcial', async (t) => {
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
      tamanho: dados.length,
      mtimeMs: data.getTime(),
      onBytes: (n, fase) => (fase === 'copiando' ? (copiando += n) : (conferindo += n)),
    })
    assert.equal(r.algoritmo, 'xxh64')
    assert.equal(r.hash, await xxh64(dados))
    assert.equal(r.bytes, dados.length)
    assert.deepEqual(r.destinos.map((d) => d.ok), [true, true])
    assert.equal(copiando, dados.length)
    assert.ok(Math.abs(conferindo - dados.length) < 2, 'conferência conta o tamanho uma vez (dividido entre os destinos)')
    for (const d of destinos) {
      assert.ok((await fsp.readFile(d)).equals(dados))
      assert.equal((await fsp.stat(d)).mtimeMs, data.getTime())
      assert.equal(fs.existsSync(d + PARCIAL), false)
    }
    // MD5 (o mesmo do Drive), e o tamanho informado errado (o arquivo "cresceu"): copia tudo do mesmo jeito.
    const r2 = await copiarArquivo({ origem: path.join(dir, 'cartao', 'A001.MP4'), destinos: [path.join(dir, 'ssd3', 'A001.MP4')], tamanho: 1000, algoritmo: 'md5' })
    assert.equal(r2.hash, md5(dados))
    assert.ok((await fsp.readFile(path.join(dir, 'ssd3', 'A001.MP4'))).equals(dados))
    // Arquivo vazio.
    await escrever(path.join(dir, 'vazio.txt'), Buffer.alloc(0))
    const r3 = await copiarArquivo({ origem: path.join(dir, 'vazio.txt'), destinos: [path.join(dir, 'ssd3', 'vazio.txt')], tamanho: 0 })
    assert.equal(r3.bytes, 0)
    assert.equal((await fsp.stat(path.join(dir, 'ssd3', 'vazio.txt'))).size, 0)
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

  test('serviço: compara, copia para dois SSDs com conferência, mostra velocidade e grava o relatório .xxh64', async (t) => {
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
      const rel = (await fsp.readdir(pasta)).find((n) => /^SOBEDESCE_copia_.*\.xxh64$/.test(n))
      assert.ok(rel, 'relatório no destino')
      const linhas = (await fsp.readFile(path.join(pasta, rel), 'utf8')).trim().split('\n')
      const esperado = []
      for (const [r, b] of Object.entries(arquivos).sort(([a], [b]) => (a < b ? -1 : 1))) esperado.push(`${await xxh64(b)}  ${r}`)
      assert.deepEqual(linhas, esperado, 'formato do xxhsum, em ordem')
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

  test('serviço: 300 arquivos pequenos ao mesmo tempo chegam inteiros, com relatório MD5', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'FOTOS')
    const arquivos = {}
    for (let i = 0; i < 300; i++) arquivos[`DCIM/100MSDCF/DSC${String(i).padStart(5, '0')}.ARW`] = crypto.randomBytes(1000 + ((i * 7919) % 90_000))
    arquivos['DCIM/grande.MP4'] = crypto.randomBytes(BLOCO * 2 + 5)
    for (const [rel, buf] of Object.entries(arquivos)) await escrever(path.join(org, ...rel.split('/')), buf)
    await fsp.mkdir(path.join(dir, 'SSD'))
    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())
    await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    await svc.iniciar({ algoritmo: 'md5' })
    const fim = await esperar(svc)
    assert.equal(fim.fase, 'feito', fim.erro)
    assert.equal(fim.resultado.copiados, 301)
    const total = Object.values(arquivos).reduce((s, b) => s + b.length, 0)
    assert.equal(fim.progresso.copiados, total, 'o progresso fecha exato com vários ao mesmo tempo')
    for (const [rel, buf] of Object.entries(arquivos)) assert.ok((await fsp.readFile(path.join(dir, 'SSD', 'FOTOS', ...rel.split('/')))).equals(buf), rel)
    const rel = (await fsp.readdir(path.join(dir, 'SSD', 'FOTOS'))).find((n) => n.endsWith('.md5'))
    const linhas = (await fsp.readFile(path.join(dir, 'SSD', 'FOTOS', rel), 'utf8')).trim().split('\n')
    assert.equal(linhas.length, 301)
    assert.equal(linhas[0], `${md5(arquivos['DCIM/100MSDCF/DSC00000.ARW'])}  DCIM/100MSDCF/DSC00000.ARW`)
    await assert.rejects(svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] }).then(() => svc.iniciar({ algoritmo: 'sha1' })), /Checksum inválido/)
  })

  test('serviço: "conferir os que já estão lá" acha o igual-no-tamanho estragado, copia de novo e fecha a cobertura', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'CARD')
    const bom = crypto.randomBytes(40_000)
    const estragado = crypto.randomBytes(40_000)
    await escrever(path.join(org, 'C1.MP4'), bom)
    await escrever(path.join(org, 'C2.MP4'), crypto.randomBytes(30_000))
    await escrever(path.join(org, 'C3.MP4'), crypto.randomBytes(20_000))
    await escrever(path.join(dir, 'SSD', 'CARD', 'C1.MP4'), estragado) // mesmo tamanho, outro conteúdo
    await fsp.copyFile(path.join(org, 'C2.MP4'), path.join(dir, 'SSD', 'CARD', 'C2.MP4'))
    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())

    // Sem conferir os iguais: o estragado passa como "já está lá" (por isso a opção existe).
    let v = await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    assert.deepEqual([v.plano.destinos[0].novos, v.plano.destinos[0].iguais], [1, 2])
    await svc.iniciar({})
    let fim = await esperar(svc)
    assert.deepEqual(fim.resultado.cobertura[0], { caminho: path.join(dir, 'SSD'), total: 3, presentes: 3, conferidos: 1, diferentes: 0 })

    await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    await svc.iniciar({ conferirIguais: true })
    fim = await esperar(svc)
    assert.equal(fim.fase, 'feito', fim.erro)
    assert.equal(fim.resultado.corrigidos, 1)
    assert.equal(fim.resultado.jaConferidos, 2, 'C2 e C3 conferidos pelo conteúdo')
    assert.ok((await fsp.readFile(path.join(dir, 'SSD', 'CARD', 'C1.MP4'))).equals(bom), 'o estragado foi trocado pelo certo')
    assert.deepEqual(fim.resultado.cobertura[0], { caminho: path.join(dir, 'SSD'), total: 3, presentes: 3, conferidos: 3, diferentes: 0 })
    assert.equal(fim.progresso.conferidos, fim.progresso.totalConferir, 'o progresso fecha')
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

  test('serviço: cancelar enquanto compara termina como "cancelado" (sem erro) e limpar volta ao começo', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'CARD')
    for (let i = 0; i < 4; i++) await escrever(path.join(org, `C${i}.MP4`), crypto.randomBytes(1024))
    await fsp.mkdir(path.join(dir, 'SSD'))
    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())
    const comparando = svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })
    assert.equal(svc.view().fase, 'planejando')
    svc.cancelar()
    const v = await comparando
    assert.equal(v.fase, 'cancelado')
    assert.equal(v.plano ?? null, null)
    assert.equal(v.erro ?? null, null)
    // Limpar depois de cancelar: tela limpa; e dá para comparar de novo.
    assert.equal(svc.limpar().fase, 'parado')
    assert.equal((await svc.planejar({ origem: org, destinos: [path.join(dir, 'SSD')] })).fase, 'pronto')
  })

  test('procurar em qualquer pasta: o que já está noutra pasta do SSD (nome + tamanho) não é copiado de novo', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'SSD1', 'Projeto X')
    const ssd2 = path.join(dir, 'SSD2')
    const data = new Date('2026-10-01T10:00:00Z')
    const grande = crypto.randomBytes(1024 * 1024 + 7)
    await escrever(path.join(org, 'CAM A', 'C0001.MP4'), grande, data)
    await escrever(path.join(org, 'CAM A', 'C0002.MP4'), Buffer.alloc(3000, 2), data)
    await escrever(path.join(org, 'CAM A', 'STATUS.BIN'), Buffer.alloc(64, 1), data)
    await escrever(path.join(org, 'Novo.mov'), Buffer.alloc(500, 9), data)
    // No SSD2, organizado de outro jeito: o grande (outra data, mas grande: nome + tamanho bastam), o pequeno com a
    // mesma data, e um STATUS.BIN do mesmo tamanho mas de outra data (pequeno: pode ser outro arquivo, não conta).
    await escrever(path.join(ssd2, 'Backup antigo', 'Clipes', 'C0001.MP4'), grande, new Date('2026-10-05T10:00:00Z'))
    await escrever(path.join(ssd2, 'Outra', 'c0002.mp4'), Buffer.alloc(3000, 2), new Date(data.getTime() + 1000))
    await escrever(path.join(ssd2, 'Outra', 'STATUS.BIN'), Buffer.alloc(64, 1), new Date('2026-09-01T10:00:00Z'))

    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())
    let v = await svc.planejar({ origem: org, destinos: [ssd2], procurarTudo: true })
    const d = v.plano.destinos[0]
    assert.deepEqual([d.novos, d.emOutro, d.iguais], [2, 2, 0])
    const outros = svc.itens({ estado: 'outro' }).itens
    assert.deepEqual(outros.map((x) => x.relPath).sort(), ['CAM A/C0001.MP4', 'CAM A/C0002.MP4'])
    assert.equal(outros.find((x) => x.relPath === 'CAM A/C0001.MP4').achado, path.join(ssd2, 'Backup antigo', 'Clipes', 'C0001.MP4'))
    assert.deepEqual(svc.itens({ estado: 'novo' }).itens.map((x) => x.relPath).sort(), ['CAM A/STATUS.BIN', 'Novo.mov'])

    // Copia só os 2 novos; a cobertura conta os 4 como presentes. Conferir os que já estão lá lê o achado noutra pasta.
    await svc.iniciar({ conferir: true, conferirIguais: true })
    v = await esperar(svc)
    assert.equal(v.fase, 'feito', v.erro)
    assert.equal(v.resultado.copiados, 4)
    assert.equal(v.resultado.jaConferidos, 2)
    assert.equal(v.resultado.cobertura[0].presentes, 4)
    assert.equal(fs.existsSync(path.join(ssd2, 'Projeto X', 'CAM A', 'C0001.MP4')), false, 'não duplicou o que já estava lá')
    assert.ok(fs.existsSync(path.join(ssd2, 'Projeto X', 'Novo.mov')))

    // O STATUS.BIN novo foi para junto dos vizinhos de "CAM A" (empate: a primeira pasta em ordem alfabética).
    assert.ok(fs.existsSync(path.join(ssd2, 'Backup antigo', 'Clipes', 'STATUS.BIN')))
    // Sem procurar (o Backup Automático usa assim), só o caminho esperado conta: lá só está o Novo.mov.
    v = await svc.planejar({ origem: org, destinos: [ssd2] })
    assert.deepEqual([v.plano.destinos[0].novos, v.plano.destinos[0].emOutro, v.plano.destinos[0].iguais], [3, 0, 1])
  })

  test('conferir os que já estão lá: os novos são copiados primeiro; a média conta o trabalho todo', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'CARD')
    const ssd = path.join(dir, 'SSD')
    // "A..." vem antes na ordem alfabética e já está no destino; "Z..." é novo. Grandes (65 MB): um por vez, na ordem.
    const grande = 65 * 1024 * 1024
    const buf = crypto.randomBytes(grande)
    await escrever(path.join(org, 'A0.MOV'), buf)
    await escrever(path.join(ssd, 'CARD', 'A0.MOV'), buf)
    await escrever(path.join(org, 'Z0.MOV'), Buffer.alloc(grande, 7))
    const vistos = []
    const svc = new DiscosService({ keepAwake: semDormir, onChange: (v) => v.progresso && vistos.push(v.progresso) })
    t.after(() => svc.close())
    await svc.planejar({ origem: org, destinos: [ssd] })
    assert.equal(svc.plano.destinos[0].bytesIguais, grande)
    await svc.iniciar({ conferir: true, conferirIguais: true })
    const fim = await esperar(svc)
    assert.equal(fim.fase, 'feito', fim.erro)
    const primeiroConferindo = vistos.find((g) => g.soConferindo)
    assert.ok(primeiroConferindo, 'passou pela conferência dos que já estavam lá')
    assert.equal(primeiroConferindo.copiados, grande, 'o novo já estava copiado quando começou a conferir o outro')
    assert.ok(fim.progresso.velocidadeMedia > 0)
  })

  test('juntar aos vizinhos: o C055 que falta vai para a pasta onde já estão o C054 e o C056', async (t) => {
    const dir = await tmp(t)
    const org = path.join(dir, 'Card 01')
    const ssd = path.join(dir, 'SSD2')
    const camA = path.join(ssd, 'Projeto', 'Dia 01', 'Cam A')
    const data = new Date('2026-10-01T10:00:00Z')
    for (const n of ['C054', 'C056']) {
      const buf = Buffer.alloc(5000, n.charCodeAt(3))
      await escrever(path.join(org, 'PRIVATE', 'CLIP', `${n}.MP4`), buf, data)
      await escrever(path.join(camA, `${n}.MP4`), buf, data)
    }
    await escrever(path.join(org, 'PRIVATE', 'CLIP', 'C055.MP4'), Buffer.alloc(6000, 5), data)
    await escrever(path.join(org, 'PRIVATE', 'CLIP', 'SUB', 'C055.XML'), Buffer.alloc(300, 1), data)
    await escrever(path.join(org, 'OUTRA', 'solto.wav'), Buffer.alloc(200, 2), data)

    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())
    let v = await svc.planejar({ origem: org, destinos: [ssd], procurarTudo: true })
    assert.equal(v.plano.destinos[0].juntos, 2, 'o C055 e o XML da subpasta; o solto não tem vizinhos')
    const novos = Object.fromEntries(svc.itens({ estado: 'novo' }).itens.map((x) => [x.relPath, x.para]))
    assert.equal(novos['PRIVATE/CLIP/C055.MP4'], path.join(camA, 'C055.MP4'))
    assert.equal(novos['PRIVATE/CLIP/SUB/C055.XML'], path.join(camA, 'SUB', 'C055.XML'))
    assert.equal(novos['OUTRA/solto.wav'], null)

    await svc.iniciar({ conferir: true })
    v = await esperar(svc)
    assert.equal(v.fase, 'feito', v.erro)
    assert.ok(fs.existsSync(path.join(camA, 'C055.MP4')), 'foi para junto dos vizinhos')
    assert.ok(fs.existsSync(path.join(camA, 'SUB', 'C055.XML')))
    assert.ok(fs.existsSync(path.join(ssd, 'Card 01', 'OUTRA', 'solto.wav')), 'sem vizinhos: na pasta da cópia')
    assert.equal(fs.existsSync(path.join(ssd, 'Card 01', 'PRIVATE', 'CLIP', 'C055.MP4')), false)
    assert.equal(v.resultado.cobertura[0].presentes, 5)

    // Desligado: vai tudo para a pasta da cópia.
    const org2 = path.join(dir, 'Card 02')
    await escrever(path.join(org2, 'C054.MP4'), Buffer.alloc(5000, 52), data)
    await escrever(path.join(org2, 'C057.MP4'), Buffer.alloc(7000, 7), data)
    await svc.planejar({ origem: org2, destinos: [ssd], procurarTudo: true })
    await svc.iniciar({ conferir: false, juntar: false })
    v = await esperar(svc)
    assert.equal(v.fase, 'feito', v.erro)
    assert.ok(fs.existsSync(path.join(ssd, 'Card 02', 'C057.MP4')))
    assert.equal(fs.existsSync(path.join(camA, 'C057.MP4')), false)
  })

  test('procurar em qualquer pasta: a origem dentro do destino não se acha a si mesma', async (t) => {
    const dir = await tmp(t)
    const ssd = path.join(dir, 'SSD')
    const org = path.join(ssd, 'Cartao')
    await escrever(path.join(org, 'A.MOV'), crypto.randomBytes(2 * 1024 * 1024))
    const svc = new DiscosService({ keepAwake: semDormir })
    t.after(() => svc.close())
    const v = await svc.planejar({ origem: org, destinos: [ssd], nome: 'Copia', procurarTudo: true })
    assert.deepEqual([v.plano.destinos[0].novos, v.plano.destinos[0].emOutro], [1, 0])
  })

  test('rota: repassa todas as opções da tela para o serviço', async () => {
    const rotas = {}
    let recebido = null
    let planejado = null
    const servico = { iniciar: async (o) => ((recebido = o), {}), planejar: async (o) => ((planejado = o), {}), view: () => ({}), close: async () => {} }
    registerDiscos({ route: (m, p, fn) => (rotas[`${m} ${p}`] = fn), ctx: {}, HttpProblem: Error, servico })
    await rotas['POST /api/discos/iniciar']({ body: { substituir: true, conferir: false, conferirIguais: true, relatorio: false, algoritmo: 'md5' } })
    assert.deepEqual(recebido, { substituir: true, conferir: false, conferirIguais: true, relatorio: false, algoritmo: 'md5', juntar: true })
    await rotas['POST /api/discos/iniciar']({ body: {} })
    assert.deepEqual(recebido, { substituir: false, conferir: true, conferirIguais: false, relatorio: true, algoritmo: 'xxh64', juntar: true })
    await rotas['POST /api/discos/planejar']({ body: { origem: '/a', destinos: ['/b'] } })
    assert.equal(planejado.procurarTudo, true, 'a tela compara procurando em qualquer pasta')
    await rotas['POST /api/discos/planejar']({ body: { origem: '/a', destinos: ['/b'], procurarTudo: false } })
    assert.equal(planejado.procurarTudo, false)
  })
})
