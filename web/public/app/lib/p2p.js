// Celular ↔ computador (e celular ↔ celular) pelo Wi-Fi (docs/CELULAR-WIFI.md): a espera longa no site (sinais e
// presença), a lista de aparelhos ligados agora (os da conta e, de quem ligou "aceitar de outras pessoas", os da mesma
// rede), mandar arquivos para um deles e receber o que mandam. A conexão é WebRTC direto na rede local; o site só
// repassa a oferta e a resposta. O protocolo dentro do canal fica em p2p-canal.js.
//
// Só com a conta (não no modo Wi-Fi via QR, LAN) e só com a tela à vista: o iPhone pausa a página em segundo plano.
// Receber sempre pede Aceitar no celular, inclusive dos computadores da própria conta.
import { LAN, local } from './config.js'
import { closeSheet, getState, openSheet, setState, toast } from './state.js'
import { keepAwake } from './wakelock.js'
import { CANAL, CanalError, enviarArquivos, esperarAberto, esperarCandidatos, receberArquivos } from './p2p-canal.js'
import { DICA_MAC, LIMITE_MEMORIA, Medidor, candidatosDaSdp, mensagemDe, nomeAparelho, nomeSeguro, ondeGuardar, resumoConexao, textoConexao, tipoDe } from './p2p-util.js'

export const API = { espera: '/api/p2p/espera', aparelhos: '/api/p2p/aparelhos', sinal: '/api/p2p/sinal' }

const APARELHOS_MS = 20_000
const RESPOSTA_MS = 45_000 // computador da conta: aceita sozinho
const RESPOSTA_PESSOA_MS = 115_000 // celular ou outra pessoa: alguém precisa tocar em Aceitar (o sinal vale 2 min)
const OUTROS_KEY = 'sobedesce.p2p.outros'
// STUN só para descobrir o endereço quando os dois lados anunciam nomes .local (celular ↔ celular); os dados não
// passam por ele. Sem TURN: fora da mesma rede não conecta.
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const TELA_MS = 200 // de quanto em quanto o andamento vai para a tela
const PASTA = 'sobedesce-recebidos'
const HEADERS = { accept: 'application/json', 'x-sobedesce-app': 'celular' }
const ANDANDO = new Set(['conectando', 'esperando', 'andando'])

let started = false
let desligado = false // o site disse 401: para até entrar de novo
let laco = null
let timerAparelhos = 0
let falhas = 0
const esperandoResposta = new Map() // id da oferta → { ok, erro }

/** "Aceitar de outras pessoas por perto": guardado neste aparelho, vai na espera como outros=1. */
export const aceitaOutros = () => Boolean(local.get(OUTROS_KEY, false))

export function setAceitarOutros(on) {
  local.set(OUTROS_KEY, on ? true : null)
  setP2p({ outros: Boolean(on) })
  // A espera em curso não é cortada (um sinal entregue a um pedido cortado se perderia): o ajuste vale na próxima,
  // em no máximo 25 s.
  acordar()
}

const setP2p = (patch) => setState((s) => ({ p2p: { ...s.p2p, ...(typeof patch === 'function' ? patch(s.p2p) : patch) } }))

// ───── espera longa e lista de computadores ─────

function ativo() {
  return started && !desligado && !LAN && document.visibilityState === 'visible' && getState().auth.status === 'signedIn'
}

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms))

async function lerJson(res) {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

async function rodarEspera() {
  if (laco) return laco
  laco = (async () => {
    while (ativo()) {
      try {
        const q = `?nome=${encodeURIComponent(nomeAparelho(navigator.userAgent))}${aceitaOutros() ? '&outros=1' : ''}`
        const res = await fetch(`${API.espera}${q}`, { headers: HEADERS, cache: 'no-store', credentials: 'same-origin' })
        if (res.status === 401) {
          desligado = true
          break
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const d = await lerJson(res)
        falhas = 0
        for (const s of Array.isArray(d.sinais) ? d.sinais : []) tratarSinal(s)
      } catch {
        falhas++
        await dormir(Math.min(30_000, 1000 * 2 ** Math.min(falhas, 5)))
      }
    }
  })().finally(() => {
    laco = null
  })
  return laco
}

export async function atualizarAparelhos() {
  if (LAN || getState().auth.status !== 'signedIn') return
  try {
    const res = await fetch(API.aparelhos, { headers: HEADERS, cache: 'no-store', credentials: 'same-origin' })
    if (res.status === 401) return setP2p({ aparelhos: [] })
    if (!res.ok) return
    const d = await lerJson(res)
    const lista = (Array.isArray(d.aparelhos) ? d.aparelhos : []).filter((a) => a?.id && (a.tipo === 'computador' || a.tipo === 'celular'))
    // Os da conta primeiro (computadores antes de celulares), depois na mesma rede, depois por nome.
    const peso = (a) => (a.conta === 'outra' ? 2 : 0) + (a.tipo === 'celular' ? 1 : 0)
    lista.sort((a, b) => peso(a) - peso(b) || Number(Boolean(b.mesmaRede)) - Number(Boolean(a.mesmaRede)) || String(a.dono || a.nome).localeCompare(String(b.dono || b.nome), 'pt-BR'))
    setP2p({ aparelhos: lista })
  } catch {
    // sem rede agora: fica a última lista
  }
}

function agendarAparelhos() {
  clearTimeout(timerAparelhos)
  timerAparelhos = 0
  if (!ativo()) return
  timerAparelhos = setTimeout(async () => {
    await atualizarAparelhos()
    agendarAparelhos()
  }, APARELHOS_MS)
}

// Tela escondida: a espera em curso termina sozinha (no máximo 25 s) e não começa outra. Não é cortada: um sinal que o
// site entregasse a um pedido cortado se perderia.
function acordar() {
  if (!ativo()) {
    clearTimeout(timerAparelhos)
    return
  }
  rodarEspera()
  atualizarAparelhos()
  agendarAparelhos()
}

/** Começa depois de entrar na conta (app.js). Chamar de novo não duplica. */
export function startP2p() {
  if (LAN) return
  if (getState().auth.status === 'signedIn') desligado = false
  if (!started) {
    started = true
    document.addEventListener('visibilitychange', acordar)
    limparSobras()
  }
  acordar()
}

// ───── sinais ─────

async function mandarSinal(corpo) {
  const res = await fetch(API.sinal, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(corpo) })
  const d = await lerJson(res)
  if (!res.ok) throw new CanalError(d.mensagem || 'O site não aceitou o pedido agora. Tente de novo.', res.status === 404 ? 'sumiu' : 'site')
  return d
}

function tratarSinal(s) {
  if (!s || typeof s !== 'object') return
  if ((s.tipo === 'resposta' || s.tipo === 'recusa') && esperandoResposta.has(s.oferta)) {
    const w = esperandoResposta.get(s.oferta)
    esperandoResposta.delete(s.oferta)
    return s.tipo === 'resposta' ? w.ok(s) : w.erro(new CanalError(s.motivo || 'O computador recusou.', 'recusado'))
  }
  if (s.tipo === 'cancela') {
    const { envio, recebimento } = getState().p2p
    if (envio?.ofertaId === s.oferta && ANDANDO.has(envio.fase)) return cancelarEnvio({ avisar: false, motivo: s.motivo || `${quemManda(envio.para)} cancelou.` })
    if (recebimento?.sinal?.id === s.oferta) {
      if (recebimento.fase === 'pedido') {
        setP2p({ recebimento: null })
        if (getState().sheet?.name === 'p2pReceber') closeSheet()
        return toast(`${quemManda(recebimento.de)} desistiu de mandar`)
      }
      if (ANDANDO.has(recebimento.fase)) return cancelarRecebimento({ avisar: false, motivo: s.motivo || `${quemManda(recebimento.de)} cancelou.` })
    }
    return
  }
  if (s.tipo === 'oferta' && s.sdp && s.de?.id) return novaOferta(s)
}

/** Quem está do outro lado, para as frases: o primeiro nome da pessoa (outra conta) ou o nome do aparelho. */
export function quemManda(de) {
  if (de?.conta === 'outra' && de.dono) return String(de.dono).trim().split(/\s+/)[0]
  return de?.nome || (de?.tipo === 'celular' ? 'O celular' : 'O computador')
}

function novaOferta(s) {
  const atual = getState().p2p.recebimento
  if (atual && (ANDANDO.has(atual.fase) || atual.fase === 'pedido')) {
    mandarSinal({ para: s.de.id, tipo: 'recusa', oferta: s.id, motivo: 'Este celular já está recebendo outra coisa. Tente daqui a pouco.' }).catch(() => {})
    return
  }
  // O que ficou de uma recepção anterior (e não foi fechado) sai agora.
  if (atual) descartarArmazem(atual)
  setP2p({ recebimento: { fase: 'pedido', sinal: s, de: s.de, resumo: s.resumo || {}, recebidos: [], bytes: 0, total: Number(s.resumo?.bytes) || 0, velocidade: 0, erro: null } })
  if (!getState().sheet) openSheet('p2pReceber')
  else toast(`${quemManda(s.de)} quer mandar arquivos. Veja no Início.`, { ms: 5000 })
}

function esperarResposta(id, ms = RESPOSTA_MS) {
  return new Promise((ok, erro) => {
    const t = setTimeout(() => {
      esperandoResposta.delete(id)
      erro(new CanalError(ms > RESPOSTA_MS ? 'Ninguém aceitou a tempo no outro aparelho.' : 'O computador não respondeu. Confira se o SOBEDESCE está aberto nele e na mesma conta.', 'sem-resposta'))
    }, ms)
    esperandoResposta.set(id, { ok: (v) => (clearTimeout(t), ok(v)), erro: (e) => (clearTimeout(t), erro(e)) })
  })
}

function novaConexao() {
  if (typeof RTCPeerConnection === 'undefined') throw new CanalError('Este navegador não consegue conectar direto no Wi-Fi. Atualize o sistema ou use o Safari/Chrome.', 'suporte')
  return new RTCPeerConnection({ iceServers: ICE })
}

// Andamento na tela no máximo a cada TELA_MS (o canal avisa a cada 64 KiB).
function relogio(fn) {
  let ultimo = 0
  return (p, forcar = false) => {
    const t = Date.now()
    if (!forcar && t - ultimo < TELA_MS) return
    ultimo = t
    fn(p)
  }
}

// ───── mandar para o computador ─────

let envioAtual = null // { cancelado, pc, ofertaId, para }

/** Manda os arquivos escolhidos para um aparelho (computador ou celular). A folha "p2pEnvio" mostra o andamento. */
export async function mandarPara(aparelhoId, files) {
  const lista = Array.from(files || []).filter(Boolean)
  if (!lista.length) return
  const atual = getState().p2p.envio
  if (atual && ANDANDO.has(atual.fase)) return toast('Espere terminar o envio que está passando.')
  const comp = getState().p2p.aparelhos.find((a) => a.id === aparelhoId) || { id: aparelhoId, nome: 'Computador', tipo: 'computador', conta: 'minha' }
  const automatico = comp.tipo === 'computador' && comp.conta !== 'outra'
  const total = lista.reduce((s, f) => s + f.size, 0)
  const arquivos = lista.map((f) => ({ nome: f.name || 'arquivo', tamanho: f.size, tipo: f.type || '' }))
  const meu = { cancelado: false, pc: null, ofertaId: null, para: comp.id }
  envioAtual = meu
  setP2p({ envio: { fase: 'conectando', para: { id: comp.id, nome: comp.nome, tipo: comp.tipo || 'computador', conta: comp.conta || 'minha', dono: comp.dono || null }, arquivos, atual: 0, bytes: 0, total, velocidade: 0, erro: null, ofertaId: null } })
  openSheet('p2pEnvio')
  const medidor = new Medidor()
  const tela = relogio((p) => setP2p((s) => (s.envio && envioAtual === meu ? { envio: { ...s.envio, atual: p.i, bytes: p.enviados, velocidade: medidor.velocidade } } : {})))
  try {
    const pc = (meu.pc = novaConexao())
    const dc = pc.createDataChannel(CANAL, { ordered: true })
    await pc.setLocalDescription(await pc.createOffer())
    await esperarCandidatos(pc)
    if (meu.cancelado) throw new CanalError('Cancelado.', 'cancelado')
    const { id } = await mandarSinal({
      para: comp.id,
      tipo: 'oferta',
      sdp: pc.localDescription.sdp,
      resumo: { arquivos: arquivos.length, bytes: total, nomes: arquivos.slice(0, 5).map((a) => a.nome) },
    })
    meu.ofertaId = id
    setP2p((s) => ({ envio: { ...s.envio, fase: 'esperando', ofertaId: id } }))
    const resposta = await esperarResposta(id, automatico ? RESPOSTA_MS : RESPOSTA_PESSOA_MS)
    if (meu.cancelado) throw new CanalError('Cancelado.', 'cancelado')
    await pc.setRemoteDescription({ type: 'answer', sdp: resposta.sdp })
    await esperarAberto(dc)
    keepAwake(true)
    setP2p((s) => ({ envio: { ...s.envio, fase: 'andando' } }))
    await enviarArquivos(dc, arquivos, {
      ler: (i, ini, fim) => lista[i].slice(ini, fim).arrayBuffer(),
      onProgresso: (p) => {
        medidor.marcar(p.enviados)
        tela(p)
      },
      cancelado: () => meu.cancelado,
    })
    if (envioAtual === meu) setP2p((s) => ({ envio: { ...s.envio, fase: 'pronto', bytes: total, velocidade: 0 } }))
    setTimeout(() => pc.close(), 1000)
  } catch (err) {
    const falha = err?.motivo === 'rede' ? await porqueNaoConectou(meu.pc, comp.tipo === 'computador') : null
    meu.pc?.close()
    if (meu.ofertaId && err?.motivo !== 'recusado') mandarSinal({ para: comp.id, tipo: 'cancela', oferta: meu.ofertaId }).catch(() => {})
    if (envioAtual === meu) setP2p((s) => ({ envio: { ...s.envio, fase: meu.cancelado ? 'cancelado' : 'erro', erro: meu.cancelado ? meu.motivo || null : mensagemDe(err), dica: falha?.dica || null, detalhe: falha?.detalhe || null, velocidade: 0 } }))
  } finally {
    if (envioAtual === meu) keepAwake(false)
  }
}

/** Não conectou: a dica (o Mac sem Rede Local, quando o outro lado não respondeu nada) e a linha de detalhe. */
async function porqueNaoConectou(pc, computador) {
  if (!pc) return null
  try {
    const d = resumoConexao(await pc.getStats(), pc.iceConnectionState)
    d.sdpOutro = candidatosDaSdp(pc.remoteDescription?.sdp)
    return { detalhe: textoConexao(d), dica: computador && d.voltas === 0 ? DICA_MAC : null }
  } catch {
    return { detalhe: null, dica: computador ? DICA_MAC : null }
  }
}

/** Nome antigo (só computadores). */
export const mandarParaComputador = mandarPara

export function cancelarEnvio({ avisar = true, motivo = null } = {}) {
  const meu = envioAtual
  if (!meu) return
  meu.cancelado = true
  meu.motivo = motivo
  if (meu.ofertaId && esperandoResposta.has(meu.ofertaId)) {
    const w = esperandoResposta.get(meu.ofertaId)
    esperandoResposta.delete(meu.ofertaId)
    w.erro(new CanalError('Cancelado.', 'cancelado'))
  }
  if (!avisar && motivo) toast(motivo)
  // Antes do canal abrir não há quem perceba o cancelado: fecha já.
  const fase = getState().p2p.envio?.fase
  if (fase === 'conectando' || fase === 'esperando') meu.pc?.close()
}

/** Esquece o envio que terminou (folha fechada pelo OK). */
export function limparEnvio() {
  const e = getState().p2p.envio
  if (e && ANDANDO.has(e.fase)) return
  envioAtual = null
  setP2p({ envio: null })
}

// ───── receber do computador ─────

let recebimentoAtual = null // { cancelado, pc, armazem }

/** Onde o aparelho consegue guardar: OPFS pelo worker, OPFS pela página, ou nada. */
let capacidade = null
let worker = null
let seq = 0
const pendentes = new Map()

function pedirWorker(m, transferir = []) {
  return new Promise((ok, erro) => {
    const id = ++seq
    pendentes.set(id, { ok, erro })
    worker.postMessage({ ...m, id }, transferir)
  })
}

async function descobrirCapacidade() {
  if (capacidade !== null) return capacidade
  capacidade = null
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try {
      worker = new Worker(new URL('./p2p-gravar.js', import.meta.url), { type: 'module' })
      worker.onmessage = (e) => {
        const p = pendentes.get(e.data?.id)
        if (!p) return
        pendentes.delete(e.data.id)
        e.data.ok ? p.ok(e.data.valor) : p.erro(new Error(e.data.erro || 'Não consegui gravar.'))
      }
      const pode = await Promise.race([pedirWorker({ op: 'testar' }), dormir(3000).then(() => false)])
      if (pode) return (capacidade = 'worker')
    } catch {
      // sem worker de módulo: tenta pela página
    }
    worker?.terminate()
    worker = null
    if (typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype) return (capacidade = 'writable')
  }
  return (capacidade = false)
}

async function pastaOpfs(sub, criar = true) {
  const raiz = await navigator.storage.getDirectory()
  const base = await raiz.getDirectoryHandle(PASTA, { create: true })
  return sub ? base.getDirectoryHandle(sub, { create: criar }) : base
}

/** Lugar onde os arquivos de uma recepção ficam até a pessoa salvar e fechar. */
function criarArmazem(modo, sub) {
  const arquivos = [] // { nome, tipo, tamanho, file }
  return {
    modo,
    sub,
    arquivos,
    async abrir(i, info) {
      const nome = `${i}-${nomeSeguro(info.nome, i)}`
      const tipo = tipoDe(info.nome, info.tipo)
      const pronto = (file) => arquivos.push({ i, nome: nomeSeguro(info.nome, i), tipo, tamanho: info.tamanho, file })
      if (modo === 'worker') {
        const chave = `${sub}/${nome}`
        await pedirWorker({ op: 'abrir', chave, pasta: [PASTA, sub], nome })
        return {
          // Cópia transferida: o protocolo ainda lê o tamanho do pedaço depois de gravar (não pode ficar "detached").
          escrever: (u8) => {
            const buf = u8.slice().buffer
            return pedirWorker({ op: 'escrever', chave, dados: buf }, [buf])
          },
          fechar: async () => {
            await pedirWorker({ op: 'fechar', chave })
            const d = await pastaOpfs(sub)
            const f = await (await d.getFileHandle(nome)).getFile()
            pronto(new File([f], nomeSeguro(info.nome, i), { type: tipo }))
          },
          descartar: () => pedirWorker({ op: 'descartar', chave }),
        }
      }
      if (modo === 'writable') {
        const d = await pastaOpfs(sub)
        const h = await d.getFileHandle(nome, { create: true })
        const w = await h.createWritable()
        return {
          escrever: (u8) => w.write(u8),
          fechar: async () => {
            await w.close()
            const f = await h.getFile()
            pronto(new File([f], nomeSeguro(info.nome, i), { type: tipo }))
          },
          descartar: () => w.abort(),
        }
      }
      // Na memória (sem OPFS): ondeGuardar já recusou o que passa de LIMITE_MEMORIA.
      const partes = []
      return {
        escrever: (u8) => void partes.push(u8),
        fechar: async () => pronto(new File(partes, nomeSeguro(info.nome, i), { type: tipo })),
        descartar: async () => void (partes.length = 0),
      }
    },
  }
}

function descartarArmazem(r) {
  const sub = r?.armazem?.sub
  if (!sub || !r.armazem.modo || r.armazem.modo === 'memoria') return
  pastaOpfs()
    .then((d) => d.removeEntry(sub, { recursive: true }))
    .catch(() => {})
}

/** O que ficou de uma recepção que não foi fechada (app fechado no meio): sai ao abrir. */
function limparSobras() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return
  navigator.storage
    .getDirectory()
    .then((raiz) => raiz.removeEntry(PASTA, { recursive: true }))
    .catch(() => {})
}

async function espacoLivre() {
  try {
    const e = await navigator.storage?.estimate?.()
    return e?.quota ? Math.max(0, e.quota - (e.usage || 0)) : null
  } catch {
    return null
  }
}

/** Aceitar o pedido do computador: conecta e recebe. A folha "p2pReceber" mostra o andamento. */
export async function aceitarOferta() {
  const r0 = getState().p2p.recebimento
  if (!r0 || r0.fase !== 'pedido') return
  const s = r0.sinal
  const meu = { cancelado: false, pc: null, armazem: null }
  recebimentoAtual = meu
  setP2p((st) => ({ recebimento: { ...st.recebimento, fase: 'conectando' } }))
  const medidor = new Medidor()
  const tela = relogio((p) => setP2p((st) => (st.recebimento && recebimentoAtual === meu ? { recebimento: { ...st.recebimento, atual: p.i, bytes: p.recebidos, total: p.total, velocidade: medidor.velocidade } } : {})))
  try {
    const pc = (meu.pc = novaConexao())
    const canal = new Promise((ok) => pc.addEventListener('datachannel', (e) => ok(e.channel)))
    await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await esperarCandidatos(pc)
    if (meu.cancelado) throw new CanalError('Cancelado.', 'cancelado')
    await mandarSinal({ para: s.de.id, tipo: 'resposta', oferta: s.id, sdp: pc.localDescription.sdp })
    const dc = await Promise.race([canal, dormir(20_000).then(() => Promise.reject(new CanalError('', 'rede')))])
    await esperarAberto(dc)
    keepAwake(true)
    await receberArquivos(dc, {
      aceitar: async (lista) => {
        const total = lista.reduce((t, a) => t + a.tamanho, 0)
        const modo = await descobrirCapacidade()
        const d = ondeGuardar({ modo: modo || null, total, livre: modo ? await espacoLivre() : null })
        if (d.motivo) return d.motivo
        meu.armazem = criarArmazem(d.modo, `r${Date.now().toString(36)}`)
        setP2p((st) => ({ recebimento: { ...st.recebimento, fase: 'andando', lista, total, armazem: meu.armazem } }))
        return true
      },
      abrir: (i, info) => meu.armazem.abrir(i, info),
      onProgresso: (p) => {
        medidor.marcar(p.recebidos)
        tela(p)
      },
      cancelado: () => meu.cancelado,
    })
    if (recebimentoAtual === meu)
      setP2p((st) => ({ recebimento: { ...st.recebimento, fase: 'pronto', bytes: st.recebimento.total, velocidade: 0, recebidos: meu.armazem.arquivos.slice().sort((a, b) => a.i - b.i) } }))
    setTimeout(() => pc.close(), 1000)
  } catch (err) {
    const falha = err?.motivo === 'rede' ? await porqueNaoConectou(meu.pc, s.de?.tipo === 'computador') : null
    meu.pc?.close()
    if (err?.motivo !== 'recusado' && err?.motivo !== 'caiu') mandarSinal({ para: s.de.id, tipo: 'cancela', oferta: s.id }).catch(() => {})
    if (recebimentoAtual === meu) {
      descartarArmazem({ armazem: meu.armazem })
      setP2p((st) => ({ recebimento: { ...st.recebimento, fase: meu.cancelado ? 'cancelado' : 'erro', erro: meu.cancelado ? meu.motivo || null : mensagemDe(err), dica: falha?.dica || null, detalhe: falha?.detalhe || null, velocidade: 0, recebidos: [] } }))
    }
  } finally {
    if (recebimentoAtual === meu) keepAwake(false)
  }
}

export function recusarOferta() {
  const r = getState().p2p.recebimento
  if (!r || r.fase !== 'pedido') return
  mandarSinal({ para: r.de.id, tipo: 'recusa', oferta: r.sinal.id, motivo: 'Recusado no celular.' }).catch(() => {})
  setP2p({ recebimento: null })
}

export function cancelarRecebimento({ avisar = true, motivo = null } = {}) {
  const meu = recebimentoAtual
  if (!meu) return
  meu.cancelado = true
  meu.motivo = motivo
  if (!avisar && motivo) toast(motivo)
  if (getState().p2p.recebimento?.fase === 'conectando') meu.pc?.close()
}

/** Fecha a recepção: apaga do armazenamento do app o que chegou (a pessoa já salvou o que quis). */
export function fecharRecebimento() {
  const r = getState().p2p.recebimento
  if (r && ANDANDO.has(r.fase)) return
  if (r) descartarArmazem(r)
  recebimentoAtual = null
  setP2p({ recebimento: null })
}

// ───── salvar o que chegou ─────

function baixarComLink(file) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Salva um ou mais arquivos: folha de compartilhar do sistema (Salvar em Fotos/Arquivos) ou download. */
export async function salvar(files) {
  const lista = (Array.isArray(files) ? files : [files]).filter(Boolean)
  if (!lista.length) return 'nada'
  if (navigator.canShare?.({ files: lista })) {
    try {
      await navigator.share({ files: lista })
      return 'ok'
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelado'
      // NotAllowedError (sem toque recente) ou tipo não aceito: cai para o download
    }
  }
  for (const f of lista) baixarComLink(f)
  return 'baixado'
}

export const p2pAndando = (fase) => ANDANDO.has(fase)
export { LIMITE_MEMORIA }
