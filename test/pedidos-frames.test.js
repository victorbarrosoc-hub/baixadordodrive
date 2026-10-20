// Frames pedido pelo celular (src/engine/pedidos-frames.js): pega só pedidos de frames, faz um por vez pelo Frames
// (vídeo do Drive, pasta sobe ao lado dele), conta pronto/erro ao site, espera a vez se a pessoa está usando o Frames
// na tela, sem conversor não pega nada, e cancelado no celular para no meio.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PedidosFrames, ajustesDoPedido } from '../src/engine/pedidos-frames.js'
import { HttpError } from '../src/net/http.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
        if (ocupados.includes(id)) throw new HttpError(409, { body: { ok: false }, method, url: path })
        return { status: 200, data: { ok: true } }
      }
      if (method === 'PATCH' && patch404 && body?.status === 'gerando') throw new HttpError(404, { body: { ok: false }, method, url: path })
      return { status: 200, data: { ok: true } }
    },
  }
}

/** Um FramesService de mentira: cada trabalho termina como `resultado(fileId)` disser. */
function fakeFrames({ resultado = () => 'done', ffmpeg = '/usr/bin/ffmpeg', demora = 0 } = {}) {
  const trabalhos = []
  const svc = {
    job: null,
    trabalhos,
    motor: async () => (ffmpeg ? { ffmpeg: { path: ffmpeg } } : { ffmpeg: null }),
    iniciar({ origem, ajustes }) {
      if (svc.job?.status === 'running') throw Object.assign(new Error('ocupado'), { status: 409 })
      const id = `frm_${trabalhos.length + 1}abcd`
      const job = { id, status: 'running', origem, ajustes, cancelado: false }
      trabalhos.push(job)
      svc.job = job
      job.fim = (async () => {
        for (let i = 0; i < demora / 10 && !job.cancelado; i++) await sleep(10)
        job.status = job.cancelado ? 'canceled' : resultado(origem.fileId)
        if (job.status === 'error') job.erro = 'Não consegui ler este vídeo.'
      })()
      return id
    },
    async esperar(id) {
      const j = trabalhos.find((t) => t.id === id)
      await j.fim
      return { jobId: id, status: j.status, manifestoId: j.status === 'done' ? id : null, erro: j.erro }
    },
    cancelar(id) {
      const j = trabalhos.find((t) => t.id === id)
      if (j) j.cancelado = true
      return Boolean(j)
    },
    async manifesto() {
      return { frames: [{}, {}, { descartado: true }, {}], takes: [{}, {}] }
    },
  }
  return svc
}

const AJ = { frames: { quantidade: 12, formato: 'png' }, takes: { quantidade: 4, duracao: 5, formato: '9:16', codec: 'prores', audio: false } }
const pedido = (id, fileId, extra = {}) => ({ id, tipo: 'frames', fileId, contaGoogleId: 'cg1', nome: `${fileId}.mov`, status: 'pendente', ajustes: AJ, ...extra })
const patches = (cloud) => cloud.chamadas.filter((c) => c.method === 'PATCH').map((c) => ({ id: c.path.split('/')[4], ...c.body }))

describe('pedidos de frames do celular', () => {
  test('ajustes do pedido viram ajustes do Frames, com a pasta subindo ao lado do vídeo', () => {
    assert.deepEqual(ajustesDoPedido(AJ), {
      frames: { quantidade: 12, formato: 'png', logo: false },
      takes: { quantidade: 4, duracao: 5, formato: '9:16', foco: 0.5, audio: false, fade: true, codec: 'prores', logo: false },
      logo: null,
      destino: null,
      subir: 'junto',
    })
    assert.deepEqual(ajustesDoPedido({ frames: { quantidade: 9999, formato: 'gif' } }).frames, { quantidade: 24, formato: 'jpg', logo: false })
    assert.equal(ajustesDoPedido({ frames: { quantidade: 6, formato: 'jpg' }, takes: null }).takes, null)
  })

  test('faz na ordem do pedido, só os de frames, pula o que outro pegou e conta como foi', async () => {
    const cloud = fakeCloud([pedido('p3', 'f3'), pedido('px', 'fx', { tipo: 'proxy' }), pedido('p2', 'f2'), pedido('p1', 'f1')], { ocupados: ['p2'] })
    const frames = fakeFrames({ resultado: (f) => (f === 'f3' ? 'error' : 'done') })
    const svc = new PedidosFrames({ cloud, frames: () => frames, log: () => {} })
    assert.equal(await svc.consultar(), 2)
    await svc.close()
    assert.match(cloud.chamadas[0].path, /status=pendente&tipo=frames/)
    assert.deepEqual(frames.trabalhos.map((t) => t.origem), [
      { tipo: 'drive', accountId: 'nuvem:cg1', fileId: 'f1' },
      { tipo: 'drive', accountId: 'nuvem:cg1', fileId: 'f3' },
    ])
    assert.equal(frames.trabalhos[0].ajustes.subir, 'junto')
    assert.deepEqual(patches(cloud), [
      { id: 'p1', status: 'pronto', resultado: '3 frames e 2 takes, subindo para a pasta do vídeo' },
      { id: 'p3', status: 'erro', erro: 'Não consegui ler este vídeo.' },
    ])
  })

  test('a pessoa está usando o Frames na tela: espera a vez; sem conversor: não pega', async () => {
    const cloud = fakeCloud([pedido('p1', 'f1')])
    const ocupado = fakeFrames()
    ocupado.job = { status: 'running' }
    const a = new PedidosFrames({ cloud, frames: () => ocupado, log: () => {} })
    assert.equal(await a.consultar(), 0)
    await a.close()
    assert.equal(cloud.chamadas.length, 0, 'nem pergunta ao site')

    const semFfmpeg = fakeFrames({ ffmpeg: null })
    const b = new PedidosFrames({ cloud, frames: () => semFfmpeg, log: () => {} })
    assert.equal(await b.consultar(), 0)
    await b.close()
    assert.equal(cloud.chamadas.filter((c) => c.method !== 'GET').length, 0)
  })

  test('cancelado no celular (404 no sinal de vida) para o trabalho; fechando o app devolve o pedido', async () => {
    const cloud = fakeCloud([pedido('p1', 'f1')], { patch404: true })
    const frames = fakeFrames({ demora: 400 })
    const svc = new PedidosFrames({ cloud, frames: () => frames, vidaMs: 30, log: () => {} })
    assert.equal(await svc.consultar(), 0)
    await svc.close()
    assert.equal(frames.trabalhos[0].cancelado, true)
    assert.ok(!patches(cloud).some((p) => p.status === 'pronto'))

    const cloud2 = fakeCloud([pedido('p9', 'f9')])
    const lento = fakeFrames({ demora: 2000 })
    const svc2 = new PedidosFrames({ cloud: cloud2, frames: () => lento, log: () => {} })
    const rodando = svc2.consultar()
    await sleep(50)
    await svc2.close()
    await rodando
    assert.deepEqual(patches(cloud2), [{ id: 'p9', status: 'pendente' }])
  })

  test('site sem a rota (versão antiga): para de perguntar por um tempo', async () => {
    let n = 0
    const cloud = {
      signedIn: true,
      async request(method, path) {
        n++
        throw new HttpError(400, { body: { ok: false }, method, url: path })
      },
    }
    const svc = new PedidosFrames({ cloud, frames: () => fakeFrames(), log: () => {} })
    await svc.consultar()
    await svc.consultar()
    await svc.close()
    assert.equal(n, 1)
  })
})
