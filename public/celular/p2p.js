// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): o WebRTC do lado do computador. Roda numa janela oculta
// do Electron (desktop/main.js) enquanto o app está aberto. Ouve o motor pelo SSE e conversa com ele pela API local:
//  - celular-oferta: um celular da conta quer mandar → responde, recebe e grava pelo motor (PUT em blocos de 4 MiB);
//  - celular-enviar: a interface pediu para mandar → cria a oferta, espera a resposta e manda (lendo em blocos);
//  - celular-sinal: resposta/recusa a uma oferta nossa; celular-cancelar: para o que estiver andando.
import { CANAL, enviarArquivos, esperarAberto, esperarCandidatos, receberArquivos } from './p2p-canal.js'

const BLOCO = 4 * 1024 * 1024
const RESPOSTA_MS = 3 * 60_000
const CANAL_MS = 20_000
const PROGRESSO_MS = 300
const JANELA_MS = 20_000
// STUN só para descobrir caminhos na rede (quando o IP local não basta); os dados não passam por ele.
const ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }

const ativos = new Map() // tid → { pc, oferta, cancelado }
const esperandoResposta = new Map() // id da oferta → resolver
const respostasCedo = new Map() // resposta que chegou antes de começarmos a esperar

async function api(caminho, body) {
  const r = await fetch(caminho, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.ok === false) throw new Error(j.error || `Erro ${r.status}`)
  return j
}

const novoTid = () => `cel${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('')}`

function ritmado(fn, ms) {
  let ultimo = 0
  return (v) => {
    const agora = Date.now()
    if (agora - ultimo < ms) return
    ultimo = agora
    fn(v)
  }
}

/**
 * Os caminhos de uma SDP (linhas a=candidate), para a mensagem de erro dizer o que cada lado anunciou:
 * "1 local 192.168.15.x, 1 internet". IP local só até o terceiro número. (Igual a web/public/app/lib/p2p-util.js.)
 */
function candidatos(sdp) {
  const nomes = { host: 'local', srflx: 'internet', prflx: 'descoberto', relay: 'retransmitido' }
  const conta = new Map()
  for (const linha of String(sdp || '').split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/i.exec(linha)
    if (!m) continue
    const [, transporte, endereco, tipo] = m
    let onde = ''
    if (tipo === 'host') onde = /\.local$/i.test(endereco) ? '.local' : endereco.includes(':') ? 'IPv6' : endereco.split('.').slice(0, 3).join('.') + '.x'
    const k = `${nomes[tipo] || tipo}${onde ? ` ${onde}` : ''}${transporte.toLowerCase() === 'tcp' ? ' tcp' : ''}`
    conta.set(k, (conta.get(k) || 0) + 1)
  }
  const l = [...conta].map(([k, n]) => `${n} ${k}`)
  return l.length ? l.join(', ') : 'nenhum'
}

/** Não conectou: a mensagem leva o que cada lado anunciou (aparece na lista de Dispositivos e no log). */
function semConexao(pc) {
  return `Não deu para conectar no Wi-Fi (este computador: ${candidatos(pc.localDescription?.sdp)} · celular: ${candidatos(pc.remoteDescription?.sdp)} · ${pc.iceConnectionState}).`
}

function fechar(pc) {
  try {
    pc?.close()
  } catch {}
}

// ───── celular → computador ─────

async function receberOferta(s) {
  if (!s?.sdp || !s.de?.id) return
  const tid = novoTid()
  const pc = new RTCPeerConnection(ICE)
  const reg = { pc, oferta: s.id, cancelado: false }
  ativos.set(tid, reg)
  let aceito = false
  try {
    const canal = new Promise((ok) => pc.addEventListener('datachannel', (e) => ok(e.channel), { once: true }))
    await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await esperarCandidatos(pc)
    await api('/api/celular/sinal', { para: s.de.id, tipo: 'resposta', oferta: s.id, sdp: pc.localDescription.sdp })
    const dc = await Promise.race([canal, new Promise((_, erro) => setTimeout(() => erro(new Error(semConexao(pc))), CANAL_MS))])
    await esperarAberto(dc, CANAL_MS).catch(() => {
      throw new Error(semConexao(pc))
    })
    await receberArquivos(dc, {
      cancelado: () => reg.cancelado,
      aceitar: async (lista) => {
        const r = await api('/api/celular/receber', { tid, de: s.de, arquivos: lista, oferta: s.id })
        aceito = r.aceito === true
        return aceito ? true : r.motivo || 'Recusado.'
      },
      abrir: async (i) => {
        let partes = []
        let juntos = 0
        let offset = 0
        const gravar = async () => {
          if (!juntos) return
          const corpo = new Blob(partes)
          partes = []
          const n = juntos
          juntos = 0
          const r = await fetch(`/api/celular/receber/${tid}/${i}?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: corpo })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) throw new Error(j.error || `Não consegui gravar (erro ${r.status}).`)
          offset += n
        }
        return {
          escrever: async (u8) => {
            partes.push(u8.slice())
            juntos += u8.byteLength
            if (juntos >= BLOCO) await gravar()
          },
          fechar: async () => {
            await gravar()
            await api(`/api/celular/receber/${tid}/${i}/fim`, {})
          },
        }
      },
    })
  } catch (err) {
    if (aceito) await api(`/api/celular/estado/${tid}`, { estado: 'erro', erro: err?.message || 'A transferência parou.' }).catch(() => {})
    // Sem transferência na tela (nem chegou a abrir o canal): conta ao motor para Dispositivos mostrar.
    else if (!reg.cancelado) await api('/api/celular/falha', { erro: err?.message || 'Não deu para conectar.' }).catch(() => {})
  } finally {
    ativos.delete(tid)
    fechar(pc)
  }
}

// ───── computador → celular ─────

function esperarResposta(oferta) {
  const cedo = respostasCedo.get(oferta)
  if (cedo) {
    respostasCedo.delete(oferta)
    return Promise.resolve(cedo)
  }
  return new Promise((ok, erro) => {
    const t = setTimeout(() => {
      esperandoResposta.delete(oferta)
      erro(new Error('O celular não respondeu. Abra o SOBEDESCE no celular, no mesmo Wi-Fi, e tente de novo.'))
    }, RESPOSTA_MS)
    esperandoResposta.set(oferta, (s) => (clearTimeout(t), ok(s)))
  })
}

async function enviar({ tid, para, arquivos }) {
  if (!tid || !para || !Array.isArray(arquivos) || !arquivos.length) return
  const pc = new RTCPeerConnection(ICE)
  const reg = { pc, oferta: null, cancelado: false }
  ativos.set(tid, reg)
  const progresso = ritmado((bytes) => api(`/api/celular/estado/${tid}`, { estado: 'andando', bytes }).catch(() => {}), PROGRESSO_MS)
  try {
    const dc = pc.createDataChannel(CANAL, { ordered: true })
    await pc.setLocalDescription(await pc.createOffer())
    await esperarCandidatos(pc)
    const bytes = arquivos.reduce((s, a) => s + a.tamanho, 0)
    const { id } = await api('/api/celular/sinal', { para, tipo: 'oferta', sdp: pc.localDescription.sdp, tid, resumo: { arquivos: arquivos.length, bytes, nomes: arquivos.slice(0, 5).map((a) => a.nome) } })
    reg.oferta = id
    const r = await esperarResposta(id)
    if (reg.cancelado) throw new Error('Cancelado.')
    if (r.tipo !== 'resposta' || !r.sdp) throw new Error(r.motivo || 'O celular recusou.')
    await api(`/api/celular/estado/${tid}`, { estado: 'conectando' }).catch(() => {})
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp })
    await esperarAberto(dc, CANAL_MS).catch(() => {
      throw new Error(semConexao(pc))
    })
    let bloco = null
    const ler = async (i, ini, fim) => {
      if (!bloco || bloco.i !== i || ini < bloco.ini || fim > bloco.fim) {
        const ate = Math.min(arquivos[i].tamanho, ini + BLOCO)
        const resp = await fetch(`/api/celular/arquivo/${tid}/${i}`, { headers: { range: `bytes=${ini}-${ate - 1}` } })
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}))
          throw new Error(j.error || `Não consegui ler ${arquivos[i].nome}.`)
        }
        bloco = { i, ini, fim: ate, buf: new Uint8Array(await resp.arrayBuffer()) }
      }
      return bloco.buf.subarray(ini - bloco.ini, fim - bloco.ini)
    }
    await enviarArquivos(dc, arquivos, { ler, cancelado: () => reg.cancelado, onProgresso: (p) => progresso(p.enviados) })
    await api(`/api/celular/estado/${tid}`, { estado: 'pronto' }).catch(() => {})
  } catch (err) {
    if (!reg.cancelado) await api(`/api/celular/estado/${tid}`, { estado: 'erro', erro: err?.message || 'A transferência parou.' }).catch(() => {})
  } finally {
    ativos.delete(tid)
    if (reg.oferta) esperandoResposta.delete(reg.oferta)
    fechar(pc)
  }
}

// ───── eventos do motor ─────

function ouvir() {
  const es = new EventSource('/api/events')
  const json = (fn) => (e) => {
    let d
    try {
      d = JSON.parse(e.data)
    } catch {
      return
    }
    fn(d)
  }
  es.addEventListener('celular-oferta', json((s) => void receberOferta(s)))
  es.addEventListener('celular-enviar', json((e) => void enviar(e)))
  es.addEventListener(
    'celular-sinal',
    json((s) => {
      const fn = esperandoResposta.get(s.oferta)
      if (fn) {
        esperandoResposta.delete(s.oferta)
        fn(s)
      } else if (s.oferta) {
        respostasCedo.set(s.oferta, s)
        setTimeout(() => respostasCedo.delete(s.oferta), RESPOSTA_MS)
      }
    }),
  )
  es.addEventListener(
    'celular-cancelar',
    json((c) => {
      for (const [tid, reg] of ativos) {
        if (tid !== c.tid && (!c.oferta || reg.oferta !== c.oferta)) continue
        reg.cancelado = true
        if (reg.oferta) {
          const fn = esperandoResposta.get(reg.oferta)
          if (fn) (esperandoResposta.delete(reg.oferta), fn({ tipo: 'cancela', motivo: 'Cancelado.' }))
        }
        // Quem recebe para na hora; quem manda avisa o outro lado pelo canal antes de fechar.
        setTimeout(() => fechar(reg.pc), 1500)
      }
    }),
  )
  // Avisa o motor que esta janela está de pé (sem ela, ofertas do celular são recusadas na hora em vez de esperar).
  const pronta = () => api('/api/celular/janela', {}).catch(() => {})
  es.addEventListener('open', pronta)
  setInterval(pronta, JANELA_MS)
}

ouvir()
