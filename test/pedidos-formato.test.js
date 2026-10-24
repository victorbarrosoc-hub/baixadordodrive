// "Baixar como…" pedido pelo celular (src/referencias/pedidos-formato.js): pega só pedidos de formato, um por vez,
// converte pelo serviço das Referências (sobe ao lado do original), conta pronto/erro ao site com a frase do erro,
// sem ffmpeg não pega nada, cancelado no celular para no meio e fechar o app devolve o pedido.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PedidosFormato } from '../src/referencias/pedidos-formato.js'
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

/** ReferenciasService de mentira: cada exportação termina como `fim(fileId)` disser, depois de `demora` ms. */
function fakeRefs({ fim = () => ({ fase: 'pronto', driveFileId: 'novo1' }), ffmpeg = '/usr/bin/ffmpeg', demora = 0, recusa = null } = {}) {
  const ev = new EventEmitter()
  const svc = {
    pedidos: [],
    cancelados: [],
    conversor: async () => ({ ffmpeg, encoder: null }),
    async exportar(o) {
      if (recusa?.(o)) throw Object.assign(new Error('Este arquivo não está mais no Drive.'), { codigo: 'nao_encontrada' })
      const id = `fmt_${svc.pedidos.length + 1}`
      svc.pedidos.push({ id, ...o })
      setTimeout(() => {
        if (!svc.cancelados.includes(id)) ev.emit('fim', { id, ...fim(o.fileId) })
      }, demora)
      return { id, fase: 'na_fila' }
    },
    esperar: (id) => new Promise((resolve) => ev.on('fim', (t) => t.id === id && resolve(t))),
    async cancelar(id) {
      svc.cancelados.push(id)
      ev.emit('fim', { id, fase: 'cancelado' })
      return true
    },
  }
  return svc
}

const pedido = (id, fileId, formato = 'mp3-320', extra = {}) => ({ id, tipo: 'formato', fileId, contaGoogleId: 'cg1', nome: `${fileId}.mp4`, status: 'pendente', ajustes: { formato }, ...extra })
const patches = (cloud) => cloud.chamadas.filter((c) => c.method === 'PATCH').map((c) => ({ id: c.path.split('/')[4], ...c.body }))

describe('pedidos de formato do celular', () => {
  test('faz na ordem do pedido, só os de formato, pula o que outro pegou e conta como foi', async () => {
    const cloud = fakeCloud([pedido('p3', 'f3', 'wav'), pedido('px', 'fx', 'mp3-320', { tipo: 'frames' }), pedido('p2', 'f2'), pedido('p1', 'f1')], { ocupados: ['p2'] })
    const refs = fakeRefs({ fim: (f) => (f === 'f3' ? { fase: 'erro', erro: { mensagem: 'Este vídeo não tem áudio.' } } : { fase: 'pronto', driveFileId: `mp3_${f}` }) })
    const svc = new PedidosFormato({ cloud, referencias: () => refs, log: () => {} })
    assert.equal(await svc.consultar(), 2)
    await svc.close()
    assert.match(cloud.chamadas[0].path, /status=pendente&tipo=formato/)
    assert.deepEqual(refs.pedidos.map((p) => [p.accountId, p.fileId, p.formato, p.destino, p.pedidoId, p.origem]), [
      ['nuvem:cg1', 'f1', 'mp3-320', 'drive', 'p1', 'pedido'],
      ['nuvem:cg1', 'f3', 'wav', 'drive', 'p3', 'pedido'],
    ])
    assert.deepEqual(patches(cloud), [
      { id: 'p1', status: 'pronto', resultado: 'MP3 320 salvo ao lado do original', proxyFileId: 'mp3_f1' },
      { id: 'p3', status: 'erro', erro: 'Este vídeo não tem áudio.' },
    ])
  })

  test('formato desconhecido ou arquivo que sumiu: erro com a frase, sem travar a fila', async () => {
    const cloud = fakeCloud([pedido('p2', 'f2'), pedido('p1', 'f1', 'flac')])
    const refs = fakeRefs({ recusa: (o) => o.fileId === 'f2' })
    const svc = new PedidosFormato({ cloud, referencias: () => refs, log: () => {} })
    assert.equal(await svc.consultar(), 2)
    await svc.close()
    assert.deepEqual(patches(cloud), [
      { id: 'p1', status: 'erro', erro: 'Formato desconhecido. Atualize o SOBEDESCE do computador.' },
      { id: 'p2', status: 'erro', erro: 'Este arquivo não está mais no Drive.' },
    ])
  })

  test('sem ffmpeg neste computador: não pega nada (fica para outro)', async () => {
    const cloud = fakeCloud([pedido('p1', 'f1')])
    const svc = new PedidosFormato({ cloud, referencias: () => fakeRefs({ ffmpeg: null }), log: () => {} })
    assert.equal(await svc.consultar(), 0)
    await svc.close()
    assert.equal(cloud.chamadas.filter((c) => c.method !== 'GET').length, 0)
  })

  test('cancelado no celular (404 no sinal de vida) para a conversão; fechando o app devolve o pedido', async () => {
    const cloud = fakeCloud([pedido('p1', 'f1')], { patch404: true })
    const refs = fakeRefs({ demora: 400 })
    const svc = new PedidosFormato({ cloud, referencias: () => refs, vidaMs: 30, log: () => {} })
    assert.equal(await svc.consultar(), 0)
    await svc.close()
    assert.deepEqual(refs.cancelados, ['fmt_1'])
    assert.ok(!patches(cloud).some((p) => p.status === 'pronto'))

    const cloud2 = fakeCloud([pedido('p9', 'f9')])
    const lento = fakeRefs({ demora: 2000 })
    const svc2 = new PedidosFormato({ cloud: cloud2, referencias: () => lento, log: () => {} })
    const rodando = svc2.consultar()
    await sleep(50)
    await svc2.close()
    await rodando
    assert.deepEqual(patches(cloud2), [{ id: 'p9', status: 'pendente' }])
  })

  test('site sem o tipo "formato" (versão antiga): para de perguntar por um tempo', async () => {
    let n = 0
    const cloud = {
      signedIn: true,
      async request(method, path) {
        n++
        throw new HttpError(400, { body: { ok: false }, method, url: path })
      },
    }
    const svc = new PedidosFormato({ cloud, referencias: () => fakeRefs(), log: () => {} })
    await svc.consultar()
    await svc.consultar()
    await svc.close()
    assert.equal(n, 1)
  })
})
