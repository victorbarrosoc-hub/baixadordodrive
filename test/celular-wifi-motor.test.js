// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md), lado do computador: o motor (src/celular/wifi.js) com um
// site falso e as rotas locais (src/server/celular.js) por HTTP de verdade. O protocolo do canal fica em
// test/celular-wifi.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { CelularWifi, listarArquivos, RECEBENDO } from '../src/celular/wifi.js'
import { validateSettings, DEFAULT_SETTINGS } from '../src/config.js'
import { startApp } from '../src/index.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sobedesce-celular-'))

function ajustes(patch = {}) {
  let atual = validateSettings({ ...patch }, DEFAULT_SETTINGS)
  const e = new EventEmitter()
  e.get = () => atual
  e.set = (p) => (atual = validateSettings(p, atual))
  return e
}

/** Site falso: guarda os sinais mandados e devolve o que o teste quiser em espera/aparelhos. */
function siteFalso({ aparelhos = [], esperas = [] } = {}) {
  const enviados = []
  const pedidos = []
  return {
    signedIn: true,
    enviados,
    pedidos,
    on() {},
    off() {},
    async request(metodo, caminho, { body, expect = [200] } = {}) {
      pedidos.push(`${metodo} ${caminho}`)
      // Como o site de verdade: status fora de `expect` vira erro
      const r = (status, data) => {
        if (!expect.includes(status)) throw Object.assign(new Error(`HTTP ${status}`), { status })
        return { status, data }
      }
      if (caminho.startsWith('/api/p2p/espera')) {
        const proxima = esperas.shift()
        if (proxima) return r(200, { sinais: proxima })
        return new Promise(() => {}) // fica esperando, como o site
      }
      if (caminho === '/api/p2p/aparelhos') return r(200, { aparelhos })
      if (caminho === '/api/p2p/sinal') {
        enviados.push(body)
        return r(201, { id: `sin${enviados.length}` }) // o site responde 201
      }
      throw new Error(`rota inesperada ${caminho}`)
    },
  }
}

function hubFalso() {
  const eventos = []
  return { eventos, send: (ev, data) => eventos.push([ev, data]) }
}

const corpo = (buf) => Readable.from([Buffer.from(buf)])

test('recebe do celular: grava na ordem, nome sem colisão, nada fica na pasta oculta e o aviso sai no fim', async () => {
  const pasta = tmp()
  fs.writeFileSync(path.join(pasta, 'IMG_0001.HEIC'), 'já estava aqui')
  const hub = hubFalso()
  const w = new CelularWifi({ settings: ajustes({ celularPasta: pasta }), cloud: siteFalso(), hub })
  const dados = crypto.randomBytes(300_000)
  const r = await w.receber({ tid: 'celteste01', de: { id: 's1', nome: 'iPhone', conta: 'minha' }, arquivos: [{ nome: 'IMG_0001.HEIC', tamanho: dados.length, tipo: 'image/heic' }, { nome: 'vazio.txt', tamanho: 0 }] })
  assert.deepEqual(r, { aceito: true })
  await w.escrever('celteste01', 0, 0, corpo(dados.subarray(0, 100_000)))
  await assert.rejects(w.escrever('celteste01', 0, 50_000, corpo(Buffer.alloc(10))), (e) => e.status === 409 && /fora de ordem/.test(e.message))
  await w.escrever('celteste01', 0, 100_000, corpo(dados.subarray(100_000)))
  assert.equal((await w.fecharArquivo('celteste01', 0)).nome, 'IMG_0001 (2).HEIC')
  assert.equal((await w.fecharArquivo('celteste01', 1)).nome, 'vazio.txt')
  assert.ok(fs.readFileSync(path.join(pasta, 'IMG_0001 (2).HEIC')).equals(dados))
  assert.equal(fs.readFileSync(path.join(pasta, 'IMG_0001.HEIC'), 'utf8'), 'já estava aqui')
  assert.deepEqual(fs.readdirSync(path.join(pasta, RECEBENDO)), [])
  const t = w.view().transferencias[0]
  assert.equal(t.estado, 'pronto')
  assert.equal(t.prontos, 2)
  assert.ok(hub.eventos.some(([ev, d]) => ev === 'toast' && /2 arquivos do iPhone chegaram/.test(d.message)))
})

test('recebe do celular: maior que o anunciado é recusado; cancelar apaga o pela metade', async () => {
  const pasta = tmp()
  const w = new CelularWifi({ settings: ajustes({ celularPasta: pasta }), cloud: siteFalso(), hub: hubFalso() })
  await w.receber({ tid: 'celteste02', de: { id: 's1', nome: 'iPhone' }, arquivos: [{ nome: 'a.mov', tamanho: 10 }] })
  await w.escrever('celteste02', 0, 0, corpo(Buffer.from('abcd')))
  await assert.rejects(w.escrever('celteste02', 0, 4, corpo(Buffer.alloc(11))), (e) => e.status === 413)
  // O pedaço recusado não fica no arquivo: o próximo continua do ponto confirmado e o arquivo fecha certo.
  await w.escrever('celteste02', 0, 4, corpo(Buffer.from('efghij')))
  await w.fecharArquivo('celteste02', 0)
  assert.equal(fs.readFileSync(path.join(pasta, 'a.mov'), 'utf8'), 'abcdefghij')
  await w.receber({ tid: 'celteste03', de: { id: 's1', nome: 'iPhone' }, arquivos: [{ nome: 'b.mov', tamanho: 100 }] })
  await w.escrever('celteste03', 0, 0, corpo(Buffer.alloc(40)))
  assert.ok(fs.readdirSync(path.join(pasta, RECEBENDO)).some((n) => n.startsWith('celteste03')))
  await w.cancelar('celteste03')
  assert.ok(!fs.readdirSync(path.join(pasta, RECEBENDO)).some((n) => n.startsWith('celteste03')))
  await assert.rejects(w.escrever('celteste03', 0, 40, corpo(Buffer.alloc(10))), (e) => e.status === 409)
  assert.deepEqual(fs.readdirSync(pasta).filter((n) => n !== RECEBENDO), ['a.mov'], 'só o que fechou certo')
})

test('com "Receber do celular" desligado: recusa o arquivo e a oferta pelo site', async () => {
  const site = siteFalso()
  const hub = hubFalso()
  const w = new CelularWifi({ settings: ajustes({ celularPasta: tmp(), celularReceber: false }), cloud: site, hub })
  w.janela()
  const r = await w.receber({ tid: 'celteste04', de: { id: 's1' }, arquivos: [{ nome: 'a', tamanho: 1 }] })
  assert.equal(r.aceito, false)
  await w.tratarSinal({ id: 'of1', tipo: 'oferta', sdp: 'v=0', de: { id: 's1', nome: 'iPhone', tipo: 'celular', conta: 'minha' } })
  assert.deepEqual([site.enviados[0].tipo, site.enviados[0].oferta, site.enviados[0].para], ['recusa', 'of1', 's1'])
  assert.ok(!hub.eventos.some(([ev]) => ev === 'celular-oferta'))
})

test('oferta da mesma conta vai direto para a janela oculta; sem a janela, recusa na hora', async () => {
  const site = siteFalso()
  const hub = hubFalso()
  const w = new CelularWifi({ settings: ajustes({ celularPasta: tmp() }), cloud: site, hub })
  const oferta = { id: 'of2', tipo: 'oferta', sdp: 'v=0', de: { id: 's1', nome: 'iPhone', tipo: 'celular', conta: 'minha' } }
  await w.tratarSinal(oferta)
  assert.match(site.enviados[0].motivo, /não está pronto/)
  w.janela()
  await w.tratarSinal({ ...oferta, id: 'of3' })
  assert.deepEqual(hub.eventos.filter(([ev]) => ev === 'celular-oferta').map(([, s]) => s.id), ['of3'])
})

test('Mac sem a permissão de Rede Local: recusa a oferta e o envio com o caminho para ligar, e a tela fica sabendo', async () => {
  const site = siteFalso()
  const hub = hubFalso()
  let estado = 'bloqueada'
  const redeLocal = { get estado() { return estado }, conferir: async () => estado }
  const w = new CelularWifi({ settings: ajustes({ celularPasta: tmp() }), cloud: site, hub, redeLocal })
  w.janela()
  const oferta = { id: 'of9', tipo: 'oferta', sdp: 'v=0', de: { id: 's1', nome: 'iPhone', tipo: 'celular', conta: 'minha' } }
  await w.tratarSinal(oferta)
  assert.equal(site.enviados[0].tipo, 'recusa')
  assert.match(site.enviados[0].motivo, /Rede Local/)
  assert.equal(hub.eventos.filter(([ev]) => ev === 'celular-oferta').length, 0)
  assert.equal(w.view().redeLocal, 'bloqueada')
  await assert.rejects(w.enviar({ para: 's1', caminhos: [tmp()] }), /Rede Local/)
  estado = 'ok'
  await w.tratarSinal({ ...oferta, id: 'of10' })
  assert.deepEqual(hub.eventos.filter(([ev]) => ev === 'celular-oferta').map(([, s]) => s.id), ['of10'])
})

test('a janela oculta conta que não conectou: Dispositivos mostra a última falha e o Firewall, se atrapalhar', async () => {
  const site = siteFalso()
  const fwEstado = { ligado: true, bloquearTudo: false, app: 'fora', atrapalha: true }
  const firewall = { get estado() { return fwEstado }, conferir: async () => fwEstado }
  const redeLocal = { estado: 'ok', conferir: async () => 'ok' }
  const w = new CelularWifi({ settings: ajustes({ celularPasta: tmp() }), cloud: site, hub: hubFalso(), redeLocal, firewall })
  assert.equal(w.view().ultimaFalha, null)
  w.falha('Não deu para conectar no Wi-Fi (este computador: 1 local 192.168.1.x · celular: 1 local .local · failed).')
  assert.match(w.view().ultimaFalha.erro, /192\.168\.1\.x/)
  await w.conferirRede()
  assert.equal(w.view().firewall.atrapalha, true)
})

test('de outra pessoa por perto: desligado recusa; ligado espera Aceitar ou Recusar na tela', async () => {
  const site = siteFalso()
  const hub = hubFalso()
  const st = ajustes({ celularPasta: tmp() })
  const w = new CelularWifi({ settings: st, cloud: site, hub })
  w.janela()
  const de = { id: 's9', nome: 'iPhone de Ana', tipo: 'celular', conta: 'outra', dono: 'Ana' }
  await w.tratarSinal({ id: 'of4', tipo: 'oferta', sdp: 'v=0', de, resumo: { arquivos: 2, bytes: 10, nomes: ['a.jpg'] } })
  assert.match(site.enviados.at(-1).motivo, /outras pessoas/)
  st.set({ celularOutros: true })
  await w.tratarSinal({ id: 'of5', tipo: 'oferta', sdp: 'v=0', de, resumo: { arquivos: 2, bytes: 10, nomes: ['a.jpg'] } })
  assert.ok(!hub.eventos.some(([ev]) => ev === 'celular-oferta'), 'não responde sem aceitar')
  assert.deepEqual(w.view().pedidos, [{ id: 'of5', nome: 'iPhone de Ana', dono: 'Ana', arquivos: 2, bytes: 10, nomes: ['a.jpg'] }])
  assert.ok(hub.eventos.some(([ev, d]) => ev === 'celular-pedido' && d.dono === 'Ana'))
  await w.responder('of5', true)
  assert.deepEqual(hub.eventos.filter(([ev]) => ev === 'celular-oferta').map(([, s]) => s.id), ['of5'])
  assert.deepEqual(w.view().pedidos, [])
  await w.tratarSinal({ id: 'of6', tipo: 'oferta', sdp: 'v=0', de })
  await w.responder('of6', false)
  assert.deepEqual([site.enviados.at(-1).tipo, site.enviados.at(-1).oferta], ['recusa', 'of6'])
  await assert.rejects(w.responder('of6', true), (e) => e.status === 404)
  // Cancelado no celular antes de alguém responder: o pedido some.
  await w.tratarSinal({ id: 'of8', tipo: 'oferta', sdp: 'v=0', de })
  await w.tratarSinal({ id: 'c1', tipo: 'cancela', oferta: 'of8' })
  assert.deepEqual(w.view().pedidos, [])
  // Cancelado no celular com o arquivo já chegando: a transferência ligada à oferta para e apaga o pela metade.
  await w.receber({ tid: 'celteste05', de, arquivos: [{ nome: 'x.mov', tamanho: 100 }], oferta: 'of9' })
  await w.escrever('celteste05', 0, 0, corpo(Buffer.alloc(10)))
  await w.tratarSinal({ id: 'c2', tipo: 'cancela', oferta: 'of9' })
  assert.equal(w.view().transferencias.find((t) => t.id === 'celteste05').estado, 'cancelado')
  assert.ok(hub.eventos.some(([ev, d]) => ev === 'celular-cancelar' && d.tid === 'celteste05'))
  await w.close()
})

test('espera longa: manda outros=1 com o ajuste ligado, entrega os sinais e lista só celulares', async () => {
  const site = siteFalso({
    esperas: [[{ id: 'of7', tipo: 'oferta', sdp: 'v=0', de: { id: 's1', nome: 'iPhone', tipo: 'celular', conta: 'minha' } }]],
    aparelhos: [
      { id: 's1', nome: 'iPhone', tipo: 'celular', mesmaRede: true, conta: 'minha' },
      { id: 's2', nome: 'iPhone de Ana', tipo: 'celular', mesmaRede: true, conta: 'outra', dono: 'Ana' },
      { id: 'c2', nome: 'iMac', tipo: 'computador' },
    ],
  })
  const hub = hubFalso()
  const w = new CelularWifi({ settings: ajustes({ celularPasta: tmp(), celularOutros: true }), cloud: site, hub, nome: () => 'MacBook do Victor' })
  w.janela()
  w.start()
  for (let i = 0; i < 100 && !hub.eventos.some(([ev]) => ev === 'celular-oferta'); i++) await new Promise((ok) => setTimeout(ok, 10))
  assert.ok(site.pedidos.includes('GET /api/p2p/espera?nome=MacBook%20do%20Victor&outros=1'))
  assert.ok(hub.eventos.some(([ev, s]) => ev === 'celular-oferta' && s.id === 'of7'))
  assert.deepEqual(w.view().celulares, [
    { id: 's1', nome: 'iPhone', mesmaRede: true, conta: 'minha', dono: null },
    { id: 's2', nome: 'iPhone de Ana', mesmaRede: true, conta: 'outra', dono: 'Ana' },
  ])
  await w.close()
})

test('mandar para o celular: abre pastas, pula lixo de sistema e a oferta fica ligada à transferência', async () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'Viagem', 'Dia 1'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Viagem', 'Dia 1', 'A001.MOV'), 'aaa')
  fs.writeFileSync(path.join(dir, 'Viagem', 'B.jpg'), 'bb')
  fs.writeFileSync(path.join(dir, 'Viagem', '.DS_Store'), 'x')
  fs.writeFileSync(path.join(dir, 'Viagem', '._B.jpg'), 'x')
  assert.deepEqual((await listarArquivos([path.join(dir, 'Viagem')])).map((a) => [a.nome, a.tamanho, a.tipo]), [['B.jpg', 2, 'image/jpeg'], ['A001.MOV', 3, 'video/quicktime']])
  const site = siteFalso()
  const hub = hubFalso()
  const w = new CelularWifi({ settings: ajustes({ celularPasta: tmp() }), cloud: site, hub })
  await assert.rejects(w.enviar({ para: 's1', caminhos: [] }), /Escolha o que mandar/)
  const { tid, arquivos, bytes } = await w.enviar({ para: 's1', caminhos: [path.join(dir, 'Viagem')] })
  assert.deepEqual([arquivos, bytes], [2, 5])
  const ev = hub.eventos.find(([e]) => e === 'celular-enviar')[1]
  assert.deepEqual(ev.arquivos.map((a) => a.nome), ['B.jpg', 'A001.MOV'])
  await w.sinal({ para: 's1', tipo: 'oferta', sdp: 'v=0', tid, resumo: { arquivos: 2, bytes: 5, nomes: ['B.jpg'] } })
  assert.equal(w.view().transferencias[0].estado, 'esperando')
  await w.tratarSinal({ id: 'r1', tipo: 'recusa', oferta: 'sin1', motivo: 'Recusado no celular.' })
  assert.deepEqual([w.view().transferencias[0].estado, w.view().transferencias[0].erro], ['erro', 'Recusado no celular.'])
  assert.equal(w.arquivoParaLer(tid, 1).nome, 'A001.MOV')
})

test('rotas locais: pedaço cru (octet-stream) passa pela trava do servidor, leitura por Range e erros em português', async () => {
  const home = tmp()
  const pasta = tmp()
  const app = await startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} } }, serverOptions: { log: () => {} } })
  try {
    const url = (p) => `${app.url}${p}`
    const json = async (metodo, p, body) => {
      const r = await fetch(url(p), { method: metodo, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, data: await r.json() }
    }
    assert.equal((await json('PATCH', '/api/settings', { celularPasta: pasta })).status, 200)
    let v = await json('GET', '/api/celular')
    assert.equal(v.data.pronto, false)
    await json('POST', '/api/celular/janela', {})
    v = await json('GET', '/api/celular')
    assert.deepEqual([v.data.receber, v.data.pronto, v.data.pasta, v.data.outros], [true, true, pasta, false])
    assert.equal((await json('GET', '/api/state')).data.celular.pasta, pasta, '/api/state leva o estado')

    const dados = crypto.randomBytes(5000)
    assert.deepEqual((await json('POST', '/api/celular/receber', { tid: 'celrota01', de: { id: 's1', nome: 'iPhone' }, arquivos: [{ nome: 'foto.jpg', tamanho: 5000 }] })).data, { ok: true, aceito: true })
    const put = (offset, b, tipo = 'application/octet-stream') => fetch(url(`/api/celular/receber/celrota01/0?offset=${offset}`), { method: 'PUT', headers: { 'content-type': tipo }, body: b })
    assert.equal((await put(0, dados.subarray(0, 2000), 'text/plain')).status, 415, 'tipo simples não passa')
    assert.equal((await put(0, dados.subarray(0, 2000))).status, 200)
    const errado = await put(0, dados.subarray(0, 10))
    assert.equal(errado.status, 409)
    assert.match((await errado.json()).error, /fora de ordem/)
    assert.equal((await put(2000, dados.subarray(2000))).status, 200)
    assert.equal((await json('POST', '/api/celular/receber/celrota01/0/fim', {})).data.nome, 'foto.jpg')
    assert.ok(fs.readFileSync(path.join(pasta, 'foto.jpg')).equals(dados))
    // Outra origem não grava (a trava do servidor confere a Origin).
    const fora = await fetch(url('/api/celular/receber/celrota01/0?offset=5000'), { method: 'PUT', headers: { 'content-type': 'application/octet-stream', origin: 'https://exemplo.com' }, body: 'x' })
    assert.equal(fora.status, 403)

    // Mandar precisa da conta: o site falso no lugar.
    const cloud = app.auth.cloud
    Object.defineProperty(cloud, 'signedIn', { get: () => true, configurable: true })
    cloud.request = async (_m, p) => (p === '/api/p2p/aparelhos' ? { data: { aparelhos: [{ id: 's1', nome: 'iPhone', tipo: 'celular', conta: 'minha' }] } } : { data: {} })
    const origem = path.join(tmp(), 'clipe.mov')
    const conteudo = crypto.randomBytes(10_000)
    fs.writeFileSync(origem, conteudo)
    const env = await json('POST', '/api/celular/enviar', { para: 's1', caminhos: [origem] })
    assert.equal(env.status, 200)
    const ler = (range) => fetch(url(`/api/celular/arquivo/${env.data.tid}/0`), { headers: range ? { range } : {} })
    const r1 = await ler('bytes=100-4195')
    assert.equal(r1.status, 206)
    assert.equal(r1.headers.get('content-range'), 'bytes 100-4195/10000')
    assert.ok(Buffer.from(await r1.arrayBuffer()).equals(conteudo.subarray(100, 4196)))
    const r2 = await ler()
    assert.equal(r2.status, 200)
    assert.ok(Buffer.from(await r2.arrayBuffer()).equals(conteudo))
    const r3 = await ler('bytes=20000-')
    assert.equal(r3.status, 416)
    await r3.arrayBuffer().catch(() => {})
    const r4 = await fetch(url('/api/celular/arquivo/naoexiste/0'))
    assert.equal(r4.status, 404)
    assert.match((await r4.json()).error, /não encontrado/)
    assert.equal((await json('POST', `/api/celular/estado/${env.data.tid}`, { estado: 'pronto' })).data.estado, 'pronto')
    assert.equal((await json('POST', '/api/celular/responder', { id: 'nada', aceitar: true })).status, 404)
    // A janela oculta é servida pelo motor.
    for (const p of ['/celular/p2p.html', '/celular/p2p.js', '/celular/p2p-canal.js']) assert.equal((await fetch(url(p))).status, 200, p)
  } finally {
    await app.shutdown()
  }
})
