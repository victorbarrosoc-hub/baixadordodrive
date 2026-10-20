// "Entre computadores" (src/lan/): cifra dos pedidos e dos dados, caminhos que não escapam da pasta, e o envio de
// ponta a ponta entre um enviador e um receptor de verdade (HTTP em 127.0.0.1): pastas, data, "já está lá",
// retomada depois de a conexão cair, conferência pelo xxHash64, chave errada e o Drive ao mesmo tempo.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { abrir, chaveDeOutraConta, chaveParaOutraConta, cifradorDeDados, decifradorDeDados, lerMeta, meta, novaChave, novoPar, selar } from '../src/lan/cripto.js'
import { LanReceptor, caminhoSeguro } from '../src/lan/receptor.js'
import { LanEnviador } from '../src/lan/enviador.js'
import { makeTmpDir } from './helpers.js'

const tmp = async (t) => {
  const d = await makeTmpDir('sobedesce-lan-')
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}
async function escrever(arq, buf, mtime) {
  await fsp.mkdir(path.dirname(arq), { recursive: true })
  await fsp.writeFile(arq, buf)
  if (mtime) await fsp.utimes(arq, mtime, mtime)
}
const esperarFim = async (env) => {
  for (let i = 0; i < 600; i++) {
    const v = env.view().envio
    if (v && ['pronto', 'com-falhas', 'erro', 'cancelado'].includes(v.fase)) return v
    await new Promise((ok) => setTimeout(ok, 20))
  }
  return env.view().envio
}

async function montar(t, { chaveDoReceptor, chaveNoSite, pedaco } = {}) {
  const dir = await tmp(t)
  const chave = chaveDoReceptor || novaChave()
  const settings = { get: () => ({ lanPasta: path.join(dir, 'Recebidos'), lanPorta: 0 }) }
  const fins = []
  const rec = new LanReceptor({ settings, chave: () => chave, nome: () => 'PC do Edu', plataforma: 'win32', onFim: (o) => fins.push(o) })
  const porta = await rec.iniciar()
  t.after(() => rec.parar())
  const cloud = {
    signedIn: true,
    request: async (_m, p) => ({ data: { computadores: p === '/api/lan/computadores' ? [{ id: 'pc1', nome: 'PC do Edu', plataforma: 'windows', enderecos: ['10.255.255.1', '127.0.0.1'], porta, chave: chaveNoSite || chave }] : [] } }),
  }
  const drive = []
  const env = new LanEnviador({ cloud, nome: () => 'MacBook do Victor', subirDrive: async (o) => (drive.push(o), {}), pedaco })
  t.after(() => env.close())
  return { dir, rec, env, porta, fins, drive, settings }
}

describe('entre computadores', () => {
  test('cifra: pedido selado só abre com a chave e no mesmo caminho; hora fora é recusada', () => {
    const k = novaChave()
    const s = selar(k, { a: 1 }, 'POST /x')
    assert.deepEqual(abrir(k, s, 'POST /x'), { a: 1 })
    assert.throws(() => abrir(novaChave(), s, 'POST /x'))
    assert.throws(() => abrir(k, s, 'POST /y'), 'outro caminho não abre')
    const m = meta(k, 'PUT', '/a', { offset: 5 })
    assert.equal(lerMeta(k, m, 'PUT', '/a').offset, 5)
    assert.equal(lerMeta(k, m, 'PUT', '/b'), null)
    assert.equal(lerMeta(novaChave(), m, 'PUT', '/a'), null)
    assert.equal(lerMeta(k, m, 'PUT', '/a', Date.now() + 11 * 60_000), null, 'hora fora')
  })

  test('cifra dos dados: blocos chegam em qualquer recorte; um byte mexido derruba', () => {
    const k = novaChave()
    const o = { oferta: 'abc12345', sessao: 'x'.repeat(22), arquivo: 3, offset: 1000 }
    const cif = cifradorDeDados(k, o)
    const partes = [crypto.randomBytes(5000), crypto.randomBytes(1), crypto.randomBytes(70_000)]
    const fio = Buffer.concat(partes.map(cif))
    const dec = decifradorDeDados(k, o)
    const saida = []
    for (let i = 0; i < fio.length; i += 777) saida.push(...dec.empurrar(fio.subarray(i, i + 777)))
    assert.ok(Buffer.concat(saida).equals(Buffer.concat(partes)))
    assert.equal(dec.sobra, 0)
    const mexido = Buffer.from(fio)
    mexido[100] ^= 1
    assert.throws(() => decifradorDeDados(k, o).empurrar(mexido))
    assert.throws(() => decifradorDeDados(k, { ...o, offset: 0 }).empurrar(fio), 'outra posição não abre')
  })

  test('caminhos: nada escapa da pasta de recebidos', () => {
    assert.equal(caminhoSeguro('Cam A/C0001.MP4'), 'Cam A/C0001.MP4')
    assert.equal(caminhoSeguro('a\\b\\c.txt'), 'a/b/c.txt')
    assert.equal(caminhoSeguro('./x//y.mov'), 'x/y.mov')
    assert.equal(caminhoSeguro('Cena: 1?.mov'), 'Cena_ 1_.mov')
    for (const ruim of ['../segredo', 'a/../../b', '', '/', 'CON', 'pasta/nul.txt']) assert.equal(caminhoSeguro(ruim), null, ruim)
  })

  test('manda uma pasta e um arquivo solto: chegam inteiros, com data, na pasta escolhida; Drive pedido junto', async (t) => {
    const { dir, env, fins, drive } = await montar(t)
    const data = new Date('2025-03-02T10:00:00Z')
    const arquivos = { 'Cam A/C0001.MP4': crypto.randomBytes(9 * 1024 * 1024 + 3), 'Cam A/Som/ZOOM.WAV': crypto.randomBytes(40_000), 'Cam A/vazio.txt': Buffer.alloc(0) }
    // Várias origens: cada pasta entra com o nome dela.
    for (const [r, b] of Object.entries(arquivos)) await escrever(path.join(dir, 'origem', ...r.split('/')), b, data)
    await escrever(path.join(dir, 'roteiro.pdf'), Buffer.from('%PDF-1.4 roteiro'))

    const lista = await env.computadores()
    assert.deepEqual(lista.computadores.map((c) => [c.nome, c.chave]), [['PC do Edu', undefined]], 'a chave não sai do motor')
    await env.enviar({ para: 'pc1', origens: [path.join(dir, 'origem', 'Cam A'), path.join(dir, 'roteiro.pdf')], pasta: 'Casamento Ana', drive: { accountId: 'g1', folderId: 'f1' } })
    const v = await esperarFim(env)
    assert.equal(v.fase, 'pronto', v.erro || JSON.stringify(v.falhas))
    assert.equal(v.endereco, '127.0.0.1', 'achou o endereço que responde')
    assert.equal(v.prontos, 4)
    assert.equal(v.enviados, v.bytes)
    const base = path.join(dir, 'Recebidos', 'Casamento Ana')
    for (const [r, b] of Object.entries(arquivos)) {
      const p = path.join(base, ...r.split('/'))
      assert.ok((await fsp.readFile(p)).equals(b), r)
      assert.equal((await fsp.stat(p)).mtimeMs, data.getTime(), `data de ${r}`)
    }
    assert.equal(await fsp.readFile(path.join(base, 'roteiro.pdf'), 'utf8'), '%PDF-1.4 roteiro')
    assert.deepEqual(await fsp.readdir(path.join(dir, 'Recebidos')), ['Casamento Ana'], 'sem a pasta escondida de parciais')
    assert.equal(fins.length, 1)
    assert.equal(fins[0].prontos, 4)
    assert.deepEqual(drive, [{ caminhos: [path.join(dir, 'origem', 'Cam A'), path.join(dir, 'roteiro.pdf')], accountId: 'g1', folderId: 'f1' }])

    // De novo: já está tudo lá (mesmo tamanho), nada vai pela rede.
    await env.limpar()
    await env.enviar({ para: 'pc1', origens: [path.join(dir, 'origem', 'Cam A'), path.join(dir, 'roteiro.pdf')], pasta: 'Casamento Ana' })
    const v2 = await esperarFim(env)
    assert.equal(v2.fase, 'pronto')
    assert.equal(v2.iguais, 4)
    assert.equal(v2.bytes, 0)
  })

  test('a conexão cai no meio: retoma de onde parou e o arquivo chega igual', async (t) => {
    const { dir, env, rec, porta } = await montar(t, { pedaco: 2 * 1024 * 1024 })
    const grande = crypto.randomBytes(12 * 1024 * 1024 + 5)
    await escrever(path.join(dir, 'origem', 'A001.MOV'), grande)
    await env.enviar({ para: 'pc1', origens: [path.join(dir, 'origem')], pasta: 'Brutos' })
    // Derruba o receptor quando metade chegou, e volta na mesma porta (o outro computador "piscou" na rede).
    for (let i = 0; i < 500 && !(env.view().envio?.enviados > 5 * 1024 * 1024); i++) await new Promise((ok) => setTimeout(ok, 5))
    await rec.parar()
    rec.settings = { get: () => ({ lanPasta: path.join(dir, 'Recebidos'), lanPorta: porta }) }
    await new Promise((ok) => setTimeout(ok, 300))
    await rec.iniciar()
    const v = await esperarFim(env)
    assert.equal(v.fase, 'pronto', v.erro || JSON.stringify(v.falhas))
    assert.ok((await fsp.readFile(path.join(dir, 'Recebidos', 'Brutos', 'A001.MOV'))).equals(grande), 'uma pasta só: o conteúdo vai direto')
  })

  test('chave errada: o receptor recusa sem ler nada e o envio diz o motivo', async (t) => {
    const { dir, env } = await montar(t, { chaveNoSite: novaChave() })
    await escrever(path.join(dir, 'x.mov'), Buffer.alloc(10, 1))
    await env.enviar({ para: 'pc1', origens: [path.join(dir, 'x.mov')] })
    const v = await esperarFim(env)
    assert.equal(v.fase, 'erro')
    assert.match(v.erro, /recusou a chave/)
    assert.deepEqual(await fsp.readdir(path.join(dir, 'Recebidos')).catch(() => []), [])
  })

  test('outra conta: só com a chave pública; pedido pendente até aceitar; recusa avisa; aceito com Drive de quem recebe', async (t) => {
    const dir = await tmp(t)
    const par = novoPar()
    // A chave combinada só fecha com a privada certa.
    const k = chaveParaOutraConta(par.publica)
    assert.equal(chaveDeOutraConta(par, k.efemera), k.chave)
    assert.notEqual(chaveDeOutraConta(novoPar(), k.efemera), k.chave)

    let aceita = true
    const pedidos = []
    const subidas = []
    const settings = { get: () => ({ lanPasta: path.join(dir, 'Recebidos do Marcos'), lanPorta: 0 }) }
    const rec = new LanReceptor({ settings, chave: () => novaChave(), par: () => par, aceitaOutros: () => aceita, nome: () => 'PC da Edição', onPedido: (p) => pedidos.push(p), onSubirDrive: async (o) => subidas.push(o) })
    const porta = await rec.iniciar()
    t.after(() => rec.parar())
    const outro = { id: 'pc-marcos', nome: 'PC da Edição', plataforma: 'windows', dono: 'Marcos', enderecos: ['127.0.0.1'], porta, chavePublica: par.publica }
    const cloud = { signedIn: true, request: async (_m, p) => ({ data: { computadores: p === '/api/lan/proximos' ? [outro] : [] } }) }
    const env = new LanEnviador({ cloud, nome: () => 'MacBook do Victor', pessoa: () => 'Victor' })
    t.after(() => env.close())
    const lista = await env.computadores()
    assert.deepEqual(lista.porPerto.map((c) => [c.nome, c.dono, c.chavePublica]), [['PC da Edição', 'Marcos', undefined]], 'a chave pública fica no motor')

    const dados = crypto.randomBytes(3 * 1024 * 1024 + 9)
    await escrever(path.join(dir, 'origem', 'Brutos', 'A001.MOV'), dados)

    // 1. Recusado.
    await env.enviar({ para: 'pc-marcos', origens: [path.join(dir, 'origem', 'Brutos')], pasta: 'Brutos Victor' })
    for (let i = 0; i < 200 && !rec.view().pedidos.length; i++) await new Promise((ok) => setTimeout(ok, 10))
    assert.equal(env.view().envio.fase, 'aguardando')
    assert.deepEqual(rec.view().pedidos.map((p) => [p.de, p.pessoa, p.arquivos]), [['MacBook do Victor', 'Victor', 1]])
    assert.equal(pedidos.length, 1, 'avisou o pedido')
    assert.deepEqual(await fsp.readdir(path.join(dir, 'Recebidos do Marcos')).catch(() => []), [], 'nada chega antes de aceitar')
    rec.responder(rec.view().pedidos[0].id, false)
    let v = await esperarFim(env)
    assert.equal(v.fase, 'erro')
    assert.match(v.erro, /Marcos recusou/)

    // 2. Aceito, com o Drive de quem recebe.
    env.limpar()
    await env.enviar({ para: 'pc-marcos', origens: [path.join(dir, 'origem', 'Brutos')], pasta: 'Brutos Victor' })
    for (let i = 0; i < 200 && !rec.view().pedidos.length; i++) await new Promise((ok) => setTimeout(ok, 10))
    rec.responder(rec.view().pedidos[0].id, true, { drive: { accountId: 'g-marcos', folderId: 'f9', folderName: 'Projetos' } })
    v = await esperarFim(env)
    assert.equal(v.fase, 'pronto', v.erro || JSON.stringify(v.falhas))
    const chegou = path.join(dir, 'Recebidos do Marcos', 'Brutos Victor', 'A001.MOV')
    assert.ok((await fsp.readFile(chegou)).equals(dados))
    for (let i = 0; i < 100 && !subidas.length; i++) await new Promise((ok) => setTimeout(ok, 10))
    assert.deepEqual(subidas, [{ caminhos: [path.join(dir, 'Recebidos do Marcos', 'Brutos Victor')], accountId: 'g-marcos', folderId: 'f9', folderName: 'Projetos' }])
    assert.equal(rec.view().recebendo[0].outra, true)

    // 3. Quem recebe desligou "outras contas": recusa sem ler nada.
    aceita = false
    env.limpar()
    await env.enviar({ para: 'pc-marcos', origens: [path.join(dir, 'origem', 'Brutos')], pasta: 'De novo' })
    v = await esperarFim(env)
    assert.equal(v.fase, 'erro')
    assert.match(v.erro, /não está aceitando pedidos de outras contas/)
  })
})
