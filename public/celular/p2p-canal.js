// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): o protocolo dentro do canal WebRTC, igual nos dois lados.
// Este arquivo é copiado sem mudar para public/celular/p2p-canal.js (app do computador); test/celular-wifi.test.js
// confere que as cópias são idênticas.
//
// Quem cria a oferta é sempre quem manda. Mensagens de texto são JSON; os dados vão em binário, em pedaços de 64 KiB
// (cabe em qualquer navegador). Ordem:
//   manda → { t: 'lista', arquivos: [{ i, nome, tamanho, tipo }] }
//   recebe → { t: 'pode' } | { t: 'nao', motivo }
//   para cada arquivo: manda { t: 'arquivo', i } + pedaços + { t: 'fim', i }; recebe { t: 'guardado', i } depois de gravar
//   manda { t: 'acabou' } → recebe { t: 'tchau' }
// Controle de fluxo: quem recebe confirma a cada 4 MiB ({ t: 'ack', i, bytes }) e quem manda não passa de 16 MiB sem
// confirmação. Assim o celular (ou o disco) mais lento não acumula a transferência inteira na memória.
// { t: 'cancelar', motivo } encerra dos dois lados.

export const CANAL = 'sobedesce'
export const PEDACO = 64 * 1024
const ACK_A_CADA = 4 * 1024 * 1024
const JANELA = 16 * 1024 * 1024
const BUFFER_ALTO = 8 * 1024 * 1024
const BUFFER_BAIXO = 1024 * 1024
const ESPERA_MS = 60_000

export class CanalError extends Error {
  constructor(message, motivo = 'erro') {
    super(message)
    this.name = 'CanalError'
    this.motivo = motivo
  }
}

const texto = (m) => JSON.stringify(m)

/** Fila de mensagens do canal: texto vira objeto, binário vira Uint8Array. Quem lê espera a próxima. */
function fila(dc) {
  const itens = []
  const esperando = []
  let fim = null
  const entregar = (v) => (esperando.length ? esperando.shift().ok(v) : itens.push(v))
  const encerrar = (err) => {
    fim = err
    while (esperando.length) esperando.shift().erro(err)
  }
  const onMessage = (ev) => {
    const d = ev.data
    if (typeof d === 'string') {
      let m
      try {
        m = JSON.parse(d)
      } catch {
        return encerrar(new CanalError('Mensagem estranha no canal.'))
      }
      if (m?.t === 'cancelar') return encerrar(new CanalError(m.motivo || 'O outro lado cancelou.', 'cancelado'))
      entregar(m)
    } else entregar(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
  }
  const onClose = () => encerrar(fim || new CanalError('A conexão caiu.', 'caiu'))
  dc.addEventListener('message', onMessage)
  dc.addEventListener('close', onClose)
  dc.addEventListener('error', onClose)
  return {
    proxima(ms = ESPERA_MS) {
      if (itens.length) return Promise.resolve(itens.shift())
      if (fim) return Promise.reject(fim)
      return new Promise((ok, erro) => {
        const t = setTimeout(() => {
          const k = esperando.findIndex((e) => e.ok === ok2)
          if (k >= 0) esperando.splice(k, 1)
          erro(new CanalError('O outro lado parou de responder.', 'parado'))
        }, ms)
        const ok2 = (v) => (clearTimeout(t), ok(v))
        esperando.push({ ok: ok2, erro: (e) => (clearTimeout(t), erro(e)) })
      })
    },
    /** Mensagens de controle que chegam fora de ordem (ack) são tiradas da fila por quem quiser. */
    tirar(fn) {
      const k = itens.findIndex((x) => !(x instanceof Uint8Array) && fn(x))
      return k >= 0 ? itens.splice(k, 1)[0] : null
    },
    get fim() {
      return fim
    },
    soltar() {
      dc.removeEventListener('message', onMessage)
      dc.removeEventListener('close', onClose)
      dc.removeEventListener('error', onClose)
    },
  }
}

function esperarBuffer(dc) {
  if (dc.bufferedAmount <= BUFFER_ALTO) return Promise.resolve()
  return new Promise((ok, erro) => {
    const pronto = () => (limpar(), ok())
    const caiu = () => (limpar(), erro(new CanalError('A conexão caiu.', 'caiu')))
    const limpar = () => {
      dc.removeEventListener('bufferedamountlow', pronto)
      dc.removeEventListener('close', caiu)
    }
    dc.addEventListener('bufferedamountlow', pronto)
    dc.addEventListener('close', caiu)
  })
}

/**
 * Manda os arquivos pelo canal já aberto.
 * @param {RTCDataChannel} dc
 * @param {{ nome: string, tamanho: number, tipo?: string }[]} arquivos
 * @param {{ ler: (i: number, inicio: number, fim: number) => Promise<ArrayBuffer|Uint8Array>,
 *           onProgresso?: (p: { i: number, bytes: number, total: number, enviados: number }) => void,
 *           cancelado?: () => boolean }} o
 * @returns {Promise<{ arquivos: number, bytes: number }>}
 */
export async function enviarArquivos(dc, arquivos, { ler, onProgresso, cancelado } = {}) {
  dc.binaryType = 'arraybuffer'
  dc.bufferedAmountLowThreshold = BUFFER_BAIXO
  const q = fila(dc)
  const total = arquivos.reduce((s, a) => s + a.tamanho, 0)
  let enviados = 0
  try {
    dc.send(texto({ t: 'lista', arquivos: arquivos.map((a, i) => ({ i, nome: a.nome, tamanho: a.tamanho, tipo: a.tipo || '' })) }))
    const r = await q.proxima(5 * 60_000) // a pessoa pode demorar para aceitar no outro aparelho
    if (r?.t === 'nao') throw new CanalError(r.motivo || 'O outro aparelho recusou.', 'recusado')
    if (r?.t !== 'pode') throw new CanalError('Resposta estranha do outro aparelho.')
    for (let i = 0; i < arquivos.length; i++) {
      const tam = arquivos[i].tamanho
      dc.send(texto({ t: 'arquivo', i }))
      let pos = 0
      let confirmado = 0
      while (pos < tam) {
        if (cancelado?.()) throw new CanalError('Cancelado.', 'cancelado')
        if (q.fim) throw q.fim
        // Janela: não passa de JANELA sem confirmação de quem recebe.
        while (pos - confirmado > JANELA) {
          const m = await q.proxima()
          if (m?.t === 'ack' && m.i === i) confirmado = Math.max(confirmado, m.bytes)
        }
        const ate = Math.min(tam, pos + PEDACO)
        const dados = await ler(i, pos, ate)
        const u8 = dados instanceof Uint8Array ? dados : new Uint8Array(dados)
        if (u8.byteLength !== ate - pos) throw new CanalError(`Não consegui ler ${arquivos[i].nome}.`, 'leitura')
        await esperarBuffer(dc)
        dc.send(u8)
        pos = ate
        enviados += u8.byteLength
        onProgresso?.({ i, bytes: pos, total, enviados })
        for (let a; (a = q.tirar((x) => x.t === 'ack' && x.i === i)); ) confirmado = Math.max(confirmado, a.bytes)
      }
      dc.send(texto({ t: 'fim', i }))
      for (;;) {
        const m = await q.proxima(5 * 60_000)
        if (m?.t === 'guardado' && m.i === i) break
        if (m?.t === 'nao') throw new CanalError(m.motivo || `${arquivos[i].nome} não foi gravado.`, 'gravar')
      }
      onProgresso?.({ i, bytes: tam, total, enviados })
    }
    dc.send(texto({ t: 'acabou' }))
    for (;;) {
      const m = await q.proxima(30_000)
      if (m?.t === 'tchau') break
    }
    return { arquivos: arquivos.length, bytes: enviados }
  } catch (err) {
    if (err?.motivo !== 'caiu' && dc.readyState === 'open') {
      try {
        dc.send(texto({ t: 'cancelar', motivo: err?.motivo === 'cancelado' ? 'Quem mandou cancelou.' : err?.message }))
      } catch {}
    }
    throw err
  } finally {
    q.soltar()
  }
}

/**
 * Recebe arquivos pelo canal já aberto.
 * @param {RTCDataChannel} dc
 * @param {{ aceitar: (lista: { i: number, nome: string, tamanho: number, tipo: string }[]) => Promise<true|string>,
 *           abrir: (i: number, info: object) => Promise<{ escrever: (u8: Uint8Array) => Promise<void>|void, fechar: () => Promise<void>, descartar?: () => Promise<void> }>,
 *           onProgresso?: (p: { i: number, bytes: number, total: number, recebidos: number }) => void,
 *           cancelado?: () => boolean }} o
 *   `aceitar` devolve true ou o motivo da recusa (texto).
 */
export async function receberArquivos(dc, { aceitar, abrir, onProgresso, cancelado } = {}) {
  dc.binaryType = 'arraybuffer'
  const q = fila(dc)
  let aberto = null
  try {
    const l = await q.proxima(30_000)
    if (l?.t !== 'lista' || !Array.isArray(l.arquivos) || !l.arquivos.length) throw new CanalError('Lista de arquivos estranha.')
    const lista = l.arquivos.map((a, i) => ({ i, nome: String(a.nome || `arquivo-${i + 1}`).slice(0, 255), tamanho: Math.max(0, Math.floor(Number(a.tamanho) || 0)), tipo: String(a.tipo || '').slice(0, 100) }))
    const ok = await aceitar(lista)
    if (ok !== true) {
      dc.send(texto({ t: 'nao', motivo: typeof ok === 'string' ? ok : 'Recusado.' }))
      throw new CanalError(typeof ok === 'string' ? ok : 'Recusado.', 'recusado')
    }
    dc.send(texto({ t: 'pode' }))
    const total = lista.reduce((s, a) => s + a.tamanho, 0)
    let recebidos = 0
    for (;;) {
      const m = await q.proxima()
      if (m instanceof Uint8Array) throw new CanalError('Dados fora de hora.')
      if (m?.t === 'acabou') {
        dc.send(texto({ t: 'tchau' }))
        return { arquivos: lista.length, bytes: recebidos }
      }
      if (m?.t !== 'arquivo' || !lista[m.i]) throw new CanalError('Mensagem fora de ordem.')
      const info = lista[m.i]
      aberto = await abrir(m.i, info)
      let bytes = 0
      let ultimoAck = 0
      for (;;) {
        if (cancelado?.()) throw new CanalError('Cancelado.', 'cancelado')
        const d = await q.proxima()
        if (d instanceof Uint8Array) {
          if (bytes + d.byteLength > info.tamanho) throw new CanalError(`${info.nome} veio maior do que o anunciado.`)
          await aberto.escrever(d)
          bytes += d.byteLength
          recebidos += d.byteLength
          if (bytes - ultimoAck >= ACK_A_CADA) {
            ultimoAck = bytes
            dc.send(texto({ t: 'ack', i: m.i, bytes }))
          }
          onProgresso?.({ i: m.i, bytes, total, recebidos })
          continue
        }
        if (d?.t === 'fim' && d.i === m.i) break
        throw new CanalError('Mensagem fora de ordem.')
      }
      if (bytes !== info.tamanho) throw new CanalError(`${info.nome} chegou incompleto.`)
      await aberto.fechar()
      aberto = null
      dc.send(texto({ t: 'guardado', i: m.i }))
    }
  } catch (err) {
    if (aberto?.descartar) await aberto.descartar().catch(() => {})
    if (err?.motivo !== 'caiu' && err?.motivo !== 'recusado' && dc.readyState === 'open') {
      try {
        dc.send(texto({ t: 'cancelar', motivo: err?.motivo === 'cancelado' ? 'Quem recebia cancelou.' : err?.message }))
      } catch {}
    }
    throw err
  } finally {
    q.soltar()
  }
}

/** Espera o ICE juntar os candidatos (sem trickle: a oferta e a resposta vão inteiras pelo site). */
export function esperarCandidatos(pc, ms = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((ok) => {
    const t = setTimeout(fim, ms)
    function fim() {
      clearTimeout(t)
      pc.removeEventListener('icegatheringstatechange', mudou)
      ok()
    }
    function mudou() {
      if (pc.iceGatheringState === 'complete') fim()
    }
    pc.addEventListener('icegatheringstatechange', mudou)
  })
}

/** Espera o canal abrir (ou desiste: provavelmente não estão na mesma rede). */
export function esperarAberto(dc, ms = 20_000) {
  if (dc.readyState === 'open') return Promise.resolve()
  return new Promise((ok, erro) => {
    const t = setTimeout(() => (limpar(), erro(new CanalError('Não deu para conectar. Confira se os dois estão no mesmo Wi-Fi.', 'rede'))), ms)
    const abriu = () => (limpar(), ok())
    const caiu = () => (limpar(), erro(new CanalError('Não deu para conectar. Confira se os dois estão no mesmo Wi-Fi.', 'rede')))
    const limpar = () => {
      clearTimeout(t)
      dc.removeEventListener('open', abriu)
      dc.removeEventListener('close', caiu)
    }
    dc.addEventListener('open', abriu)
    dc.addEventListener('close', caiu)
  })
}
