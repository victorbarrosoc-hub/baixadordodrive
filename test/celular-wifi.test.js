// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): o protocolo do canal (web/public/app/lib/p2p-canal.js),
// com um par de canais falsos no lugar do WebRTC, e a cópia idêntica que o app do computador usa.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { enviarArquivos, receberArquivos, PEDACO, CanalError } from '../web/public/app/lib/p2p-canal.js'

/** Dois canais ligados: o que um manda chega no outro na ordem, de forma assíncrona (como o WebRTC). */
function parDeCanais({ atraso = 0 } = {}) {
  const criar = () => {
    const t = new EventTarget()
    t.readyState = 'open'
    t.bufferedAmount = 0
    t.bufferedAmountLowThreshold = 0
    t.binaryType = 'arraybuffer'
    t.enviados = 0
    return t
  }
  const a = criar()
  const b = criar()
  const ligar = (de, para) => {
    let fila = Promise.resolve()
    de.send = (dado) => {
      if (de.readyState !== 'open') throw new Error('canal fechado')
      const copia = typeof dado === 'string' ? dado : dado.slice().buffer
      if (typeof dado !== 'string') de.enviados += dado.byteLength
      fila = fila.then(() => new Promise((ok) => setTimeout(ok, atraso))).then(() => {
        if (para.readyState !== 'open') return
        const ev = new Event('message')
        ev.data = copia
        para.dispatchEvent(ev)
      })
    }
    de.close = () => {
      for (const c of [de, para]) {
        if (c.readyState === 'closed') continue
        c.readyState = 'closed'
        c.dispatchEvent(new Event('close'))
      }
    }
  }
  ligar(a, b)
  ligar(b, a)
  return [a, b]
}

const aleatorio = (n) => new Uint8Array(crypto.randomBytes(n))

test('manda três arquivos (vazio, pequeno, com vários pedaços) e chegam iguais, na ordem, com progresso', async () => {
  const [dcA, dcB] = parDeCanais()
  const dados = [aleatorio(0), aleatorio(1000), aleatorio(PEDACO * 3 + 17)]
  const arquivos = [
    { nome: 'vazio.txt', tamanho: 0, tipo: 'text/plain' },
    { nome: 'foto.heic', tamanho: 1000, tipo: 'image/heic' },
    { nome: 'video.mov', tamanho: dados[2].length, tipo: 'video/quicktime' },
  ]
  const recebidos = []
  const progresso = []
  let listaVista = null
  const [r1, r2] = await Promise.all([
    enviarArquivos(dcA, arquivos, { ler: async (i, ini, fim) => dados[i].slice(ini, fim), onProgresso: (p) => progresso.push(p.enviados) }),
    receberArquivos(dcB, {
      aceitar: async (lista) => ((listaVista = lista), true),
      abrir: async (i) => {
        const partes = []
        return { escrever: (u8) => void partes.push(Buffer.from(u8)), fechar: async () => void (recebidos[i] = Buffer.concat(partes)) }
      },
    }),
  ])
  assert.deepEqual(listaVista.map((a) => [a.nome, a.tamanho, a.tipo]), arquivos.map((a) => [a.nome, a.tamanho, a.tipo]))
  for (let i = 0; i < 3; i++) assert.ok(Buffer.from(dados[i]).equals(recebidos[i]), `arquivo ${i}`)
  assert.deepEqual(r1, { arquivos: 3, bytes: 1000 + dados[2].length })
  assert.deepEqual(r2, r1)
  assert.equal(progresso.at(-1), r1.bytes)
})

test('quem recebe recusa: quem manda recebe o motivo e nada é aberto', async () => {
  const [dcA, dcB] = parDeCanais()
  let abriu = false
  const [envio, rec] = await Promise.allSettled([
    enviarArquivos(dcA, [{ nome: 'a.mov', tamanho: 10 }], { ler: async () => new Uint8Array(10) }),
    receberArquivos(dcB, { aceitar: async () => 'Sem espaço no disco.', abrir: async () => ((abriu = true), {}) }),
  ])
  assert.equal(envio.status, 'rejected')
  assert.equal(envio.reason.motivo, 'recusado')
  assert.match(envio.reason.message, /Sem espaço/)
  assert.equal(rec.status, 'rejected')
  assert.equal(abriu, false)
})

test('quem manda cancela no meio: quem recebe descarta o arquivo pela metade', async () => {
  const [dcA, dcB] = parDeCanais({ atraso: 1 })
  const tam = PEDACO * 20
  let pedacos = 0
  let descartou = false
  const [envio, rec] = await Promise.allSettled([
    enviarArquivos(dcA, [{ nome: 'grande.mov', tamanho: tam }], { ler: async (i, ini, fim) => new Uint8Array(fim - ini), cancelado: () => ++pedacos > 5 }),
    receberArquivos(dcB, { aceitar: async () => true, abrir: async () => ({ escrever() {}, fechar: async () => assert.fail('não pode fechar'), descartar: async () => void (descartou = true) }) }),
  ])
  assert.equal(envio.reason.motivo, 'cancelado')
  assert.ok(rec.reason instanceof CanalError)
  assert.equal(rec.reason.motivo, 'cancelado')
  assert.equal(descartou, true)
})

test('a conexão cai no meio: os dois lados param com "caiu"', async () => {
  const [dcA, dcB] = parDeCanais({ atraso: 1 })
  let n = 0
  const [envio, rec] = await Promise.allSettled([
    enviarArquivos(dcA, [{ nome: 'x.mov', tamanho: PEDACO * 50 }], {
      ler: async (i, ini, fim) => {
        if (++n === 10) dcA.close()
        return new Uint8Array(fim - ini)
      },
    }),
    receberArquivos(dcB, { aceitar: async () => true, abrir: async () => ({ escrever() {}, fechar: async () => {} }) }),
  ])
  assert.equal(envio.status, 'rejected')
  assert.equal(rec.status, 'rejected')
  assert.equal(rec.reason.motivo, 'caiu')
})

test('controle de fluxo: com quem recebe gravando devagar, quem manda não passa de ~16 MiB adiantado', async () => {
  const [dcA, dcB] = parDeCanais()
  const tam = 40 * 1024 * 1024
  let gravado = 0
  let maiorAdiantado = 0
  await Promise.all([
    enviarArquivos(dcA, [{ nome: 'longo.mov', tamanho: tam }], {
      ler: async (i, ini, fim) => {
        maiorAdiantado = Math.max(maiorAdiantado, ini - gravado)
        return new Uint8Array(fim - ini)
      },
    }),
    receberArquivos(dcB, {
      aceitar: async () => true,
      abrir: async () => ({
        escrever: async (u8) => {
          await new Promise((ok) => setImmediate(ok))
          gravado += u8.byteLength
        },
        fechar: async () => {},
      }),
    }),
  ])
  assert.equal(gravado, tam)
  assert.ok(maiorAdiantado <= 16 * 1024 * 1024 + 4 * 1024 * 1024 + PEDACO, `adiantou ${maiorAdiantado}`)
})

test('lista maior que o anunciado ou dados fora de hora são recusados', async () => {
  const [dcA, dcB] = parDeCanais()
  const rec = receberArquivos(dcB, { aceitar: async () => true, abrir: async () => ({ escrever() {}, fechar: async () => {} }) })
  dcA.send(JSON.stringify({ t: 'lista', arquivos: [{ nome: 'a', tamanho: 4 }] }))
  dcA.send(JSON.stringify({ t: 'arquivo', i: 0 }))
  dcA.send(new Uint8Array(8))
  await assert.rejects(rec, /maior do que o anunciado/)
})

test('o app do computador usa uma cópia idêntica do protocolo', () => {
  const celular = fs.readFileSync(new URL('../web/public/app/lib/p2p-canal.js', import.meta.url), 'utf8')
  const computador = fs.readFileSync(new URL('../public/celular/p2p-canal.js', import.meta.url), 'utf8')
  assert.equal(computador, celular)
})
