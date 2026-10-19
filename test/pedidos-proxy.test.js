// "Gerar proxy" pedido pelo celular (src/engine/pedidos-proxy.js): pega um por vez, quem perde a corrida segue, gera só
// o arquivo pedido (baixando do Drive se preciso), conta pronto/erro ao site, sem conversor não pega nada, cancelado no
// celular para no meio e fechando o app devolve o pedido.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PedidosProxy } from '../src/engine/pedidos-proxy.js'
import { HttpError } from '../src/net/http.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function fakeCloud(pedidos, { ocupados = [], patch404 = false } = {}) {
  const chamadas = []
  return {
    signedIn: true,
    chamadas,
    async request(method, path, { body } = {}) {
      chamadas.push({ method, path, body })
      if (method === 'GET') return { status: 200, data: { ok: true, pedidos } }
      const id = decodeURIComponent(path.split('/')[4])
      if (method === 'POST' && path.endsWith('/pegar')) {
        if (ocupados.includes(id)) throw new HttpError(409, { body: { ok: false, erro: 'ocupado' }, method, url: path })
        return { status: 200, data: { ok: true } }
      }
      if (method === 'PATCH' && patch404 && body?.status === 'gerando') throw new HttpError(404, { body: { ok: false }, method, url: path })
      return { status: 200, data: { ok: true } }
    },
  }
}

function fakeDrive(itens) {
  return {
    async getItem(id) {
      const i = itens[id]
      if (!i) throw Object.assign(new Error('not found'), { status: 404 })
      return { id, isFolder: false, parents: ['pasta1'], driveId: null, size: 100, ...i }
    },
  }
}

function fakeManager({ drive, via = 'ffmpeg' } = {}) {
  return {
    records: new Map([['t1', { type: 'upload', accountId: 'nuvem:cg1', target: { fileId: 'f1' }, local: { path: '/cartao/A001.mp4' } }]]),
    driveFor: id => (assert.equal(id, 'nuvem:cg1'), drive),
    previas: { gerarESubir: () => {}, motor: async () => ({ via }) },
  }
}

const pedido = (id, fileId, extra = {}) => ({ id, fileId, contaGoogleId: 'cg1', nome: `${fileId}.mp4`, status: 'pendente', ...extra })
const patches = cloud => cloud.chamadas.filter(c => c.method === 'PATCH').map(c => ({ id: c.path.split('/')[4], ...c.body }))

describe('pedidos de proxy do celular', () => {
  test('gera na ordem do pedido, pula o que outro pegou e conta como foi', async () => {
    // O site manda os mais novos primeiro.
    const cloud = fakeCloud([pedido('p3', 'f3'), pedido('p2', 'f2'), pedido('p1', 'f1')], { ocupados: ['p2'] })
    const drive = fakeDrive({ f1: { name: 'A001.mp4' }, f3: { name: 'A003.braw' } })
    const lotes = []
    const gerar = async o => {
      lotes.push(o)
      if (o.somente[0] === 'f1') return { feitos: 1, feitosIds: ['proxy1'], jaTinham: 0, falhou: 0, total: 1 }
      return { feitos: 0, feitosIds: [], jaTinham: 0, falhou: 1, falhas: [{ reason: 'ffmpeg parou' }], total: 1 }
    }
    const svc = new PedidosProxy({ cloud, manager: fakeManager({ drive }), gerar, log: () => {} })
    assert.equal(await svc.consultar(), 2)
    await svc.close()
    assert.deepEqual(lotes.map(l => l.somente), [['f1'], ['f3']])
    assert.equal(lotes[0].driveFolderId, 'pasta1')
    assert.equal(lotes[0].recursive, false)
    assert.equal(lotes[0].baixar, true)
    assert.equal(lotes[0].forcar, true)
    assert.equal(lotes[0].dicas.get('f1'), '/cartao/A001.mp4', 'usa o original que já está no computador')
    assert.deepEqual(patches(cloud), [
      { id: 'p1', status: 'pronto', resultado: 'Proxy pronto', proxyFileId: 'proxy1' },
      { id: 'p3', status: 'erro', erro: 'ffmpeg parou' },
    ])
  })

  test('arquivo que não é vídeo ou sumiu vira erro sem gerar', async () => {
    const cloud = fakeCloud([pedido('p2', 'sumiu'), pedido('p1', 'doc')])
    let gerou = 0
    const svc = new PedidosProxy({ cloud, manager: fakeManager({ drive: fakeDrive({ doc: { name: 'roteiro.pdf' } }) }), gerar: async () => gerou++, log: () => {} })
    await svc.consultar()
    await svc.close()
    assert.equal(gerou, 0)
    assert.deepEqual(patches(cloud).map(p => [p.id, p.status, p.erro]), [
      ['p1', 'erro', 'Esse arquivo não é um vídeo.'],
      ['p2', 'erro', 'O arquivo não está mais no Drive.'],
    ])
  })

  test('sem conversor ou sem conta: não pega nada', async () => {
    const cloud = fakeCloud([pedido('p1', 'f1')])
    const svc = new PedidosProxy({ cloud, manager: fakeManager({ drive: fakeDrive({}), via: null }), log: () => {} })
    assert.equal(await svc.consultar(), 0)
    cloud.signedIn = false
    assert.equal(await svc.consultar(), 0)
    await svc.close()
    assert.equal(cloud.chamadas.filter(c => c.method === 'POST').length, 0)
  })

  test('cancelado no celular para no meio; fechando o app devolve para a fila', async () => {
    const drive = fakeDrive({ f1: { name: 'A001.mp4' } })
    const esperaAbortar = ({ signal }) =>
      new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('parado'), { name: 'AbortError' }))))

    // O sinal de vida não segura o processo (unref): mantém o teste vivo até o abort chegar.
    const vivo = setInterval(() => {}, 1000)
    const cancelou = fakeCloud([pedido('p1', 'f1')], { patch404: true })
    const a = new PedidosProxy({ cloud: cancelou, manager: fakeManager({ drive }), gerar: esperaAbortar, vidaMs: 10, log: () => {} })
    assert.equal(await a.consultar(), 0)
    await a.close()
    assert.deepEqual(patches(cancelou).map(p => p.status).filter(s => s !== 'gerando'), [], 'nada de pronto/erro depois de cancelado')

    const fechou = fakeCloud([pedido('p1', 'f1')])
    const b = new PedidosProxy({ cloud: fechou, manager: fakeManager({ drive }), gerar: esperaAbortar, log: () => {} })
    const r = b.consultar()
    await sleep(20)
    await b.close()
    await r
    clearInterval(vivo)
    assert.deepEqual(patches(fechou), [{ id: 'p1', status: 'pendente' }])
  })

  test('site sem a rota (versão antiga): espera antes de perguntar de novo', async () => {
    let gets = 0
    const cloud = {
      signedIn: true,
      async request(method, path) {
        gets++
        throw new HttpError(404, { body: {}, method, url: path })
      },
    }
    const svc = new PedidosProxy({ cloud, manager: fakeManager({ drive: fakeDrive({}) }), log: () => {} })
    await svc.consultar()
    await svc.consultar()
    await svc.close()
    assert.equal(gets, 1)
  })
})
