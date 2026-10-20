// Consertar o clipe que perdeu o índice (Resgate, docs/CARTOES.md §7.3): a bateria acabou, o cartão saiu antes da
// hora ou a câmera travou. Os dados do vídeo estão no arquivo, mas falta o "moov" (o índice que a câmera grava no fim).
//
// Como: um clipe bom da MESMA câmera no MESMO modo (a referência) ensina os codecs, a intercalação dos pedaços e as
// tabelas. Os dados soltos do clipe quebrado são lidos do começo ao fim, reconhecendo cada pedaço: quadro de vídeo
// (H.264/H.265 pelo formato das NAL, ProRes pelo "icpf") ou pedaço de tamanho fixo (áudio PCM, metadados), conferido
// olhando o que vem depois. Áudio de tamanho variável sem cabeçalho (AAC) não dá para fatiar sem decodificar: ele é
// pulado e a tela avisa. Um arquivo NOVO é escrito com o índice remontado; o original nunca é alterado.
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Corpo, arvore, cabecalho, caminho, escrever, filho, lerMoov, lerTipo, u32 } from './caixas.js'
import { PRORES, parametrosNoQuadro, quadroNal, quadroProRes } from './nal.js'
import { OrdemExibicao, deslocamentos } from './poc.js'

const JANELA = 96 * 1024 * 1024
const FOLGA = 40 * 1024 * 1024 // quadro maior que isso não cabe na janela (ProRes 4444 XQ 8K fica abaixo)
const BUSCA_MAX = 64 * 1024 * 1024 // procurando o próximo quadro depois de um trecho que não se reconhece
const EPOCA_MOV = 2082844800 // 1904 → 1970, em segundos

export class ErroConserto extends Error {
  constructor(codigo, message) {
    super(message)
    this.name = 'ErroConserto'
    this.codigo = codigo
  }
}

// ───── leitura do arquivo ─────

async function caixasDoTopo(fh, tamanho) {
  const out = []
  let p = 0
  const cab = new Uint8Array(16)
  while (p + 8 <= tamanho) {
    await fh.read(cab, 0, 16, p)
    const c = cabecalho(cab, 0, Math.min(16, tamanho - p) + (tamanho - p > 16 ? Infinity : 0))
    if (!c) break
    let tam = c.tamanho
    if (u32(cab, 0) === 0) tam = tamanho - p
    out.push({ tipo: c.tipo, ini: p, cab: c.cab, tam })
    if (tam <= 0) break
    p += tam
  }
  return out
}

async function lerReferencia(caminhoRef) {
  const fh = await fs.open(caminhoRef, 'r')
  try {
    const { size } = await fh.stat()
    const topo = await caixasDoTopo(fh, size)
    const moov = topo.find((c) => c.tipo === 'moov')
    if (!moov || moov.ini + moov.tam > size) throw new ErroConserto('referencia', 'O clipe de referência também está sem índice. Use um clipe que abre normalmente.')
    const buf = new Uint8Array(moov.tam)
    await fh.read(buf, 0, moov.tam, moov.ini)
    const ftyp = topo.find((c) => c.tipo === 'ftyp')
    let ftypBytes = null
    if (ftyp && ftyp.tam < 4096) {
      ftypBytes = new Uint8Array(ftyp.tam)
      await fh.read(ftypBytes, 0, ftyp.tam, ftyp.ini)
    }
    return { ...lerMoov(buf), ftypBytes }
  } finally {
    await fh.close()
  }
}

// ───── o que a referência ensina ─────

const moda = (xs) => {
  const c = new Map()
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1)
  let melhor = null
  let n = -1
  for (const [x, k] of c) if (k > n) (melhor = x), (n = k)
  return melhor
}

/** Como reconhecer cada faixa da referência nos dados soltos. */
function planejar(ref) {
  const faixas = []
  for (const f of ref.faixas) {
    const p = { f, tipo: null, motivo: null }
    if (f.handler === 'vide' && f.nal && (f.codec === 'avc1' || f.codec === 'avc3' || f.codec === 'hvc1' || f.codec === 'hev1')) {
      p.tipo = 'nal'
      p.opts = { nal: f.nal.nal, hevc: f.codec === 'hvc1' || f.codec === 'hev1' }
      if (f.temCtts) p.ordem = new OrdemExibicao({ hevc: p.opts.hevc, config: f.nal.config, nal: f.nal.nal })
    } else if (f.handler === 'vide' && PRORES.has(f.codec)) p.tipo = 'prores'
    else if (f.chunks.length && f.amostras.length) {
      // Tamanho fixo: todas as amostras do mesmo tamanho (PCM, metadados de câmera, timecode).
      const tamanhos = new Set(f.amostras.map((a) => a.tam))
      if (tamanhos.size === 1) {
        p.tipo = 'fixo'
        p.tamAmostra = f.amostras[0].tam
        p.porPedaco = moda(f.chunks.map((c) => c.n))
        p.bytesPedaco = p.porPedaco * p.tamAmostra
        p.tamanhosPedaco = [...new Set(f.chunks.map((c) => c.bytes))].sort((a, b) => b - a)
      } else {
        p.tipo = 'opaco'
        p.motivo = f.handler === 'soun' ? 'O áudio deste modo (AAC) não dá para remontar sem a câmera: o vídeo volta sem som.' : 'Faixa de dados que não dá para remontar.'
      }
    } else {
      p.tipo = 'opaco'
      p.motivo = 'Faixa vazia na referência.'
    }
    p.dur = moda(f.amostras.map((a) => a.dur)) || 1
    faixas.push(p)
  }
  // Trechos que não se reconhecem (AAC): o tamanho de cada pedaço na referência limita onde procurar o próximo quadro.
  const opacos = faixas.filter((x) => x.tipo === 'opaco').flatMap((x) => x.f.chunks.map((c) => c.bytes))
  const lacuna = opacos.length ? { min: Math.min(...opacos), max: Math.max(...opacos) } : null
  const video = faixas.find((x) => x.tipo === 'nal' || x.tipo === 'prores') || null
  if (!video) throw new ErroConserto('sem_video', 'A referência não tem vídeo num formato que o conserto entende (H.264, H.265 ou ProRes).')
  // Ordem dos pedaços na referência (para prever o que vem depois de cada um).
  const ordem = ref.faixas
    .flatMap((f, i) => f.chunks.map((c) => ({ i, pos: c.pos, n: c.n })))
    .sort((a, b) => a.pos - b.pos)
  const iv = faixas.indexOf(video)
  video.porPedaco = moda(ordem.filter((c) => c.i === iv).map((c) => c.n)) || 1
  // Depois do pedaço de vídeo, qual faixa costuma vir.
  const seguintes = []
  for (let k = 0; k + 1 < ordem.length; k++) if (ordem[k].i === iv && ordem[k + 1].i !== iv) seguintes.push(ordem[k + 1].i)
  const depoisDoVideo = moda(seguintes)
  // Padrão de deslocamento (B-frames) por GOP.
  if (video.f.temCtts) {
    const gops = []
    let atual = null
    for (const a of video.f.amostras) {
      if (a.chave || !atual) {
        atual = []
        gops.push(atual)
      }
      atual.push(a.cts)
    }
    const tam = moda(gops.slice(0, -1).map((g) => g.length)) ?? gops[0]?.length
    video.gop = gops.find((g, i) => g.length === tam && i > 0) || gops.find((g) => g.length === tam) || null
    video.ctsInicio = gops[0] || null
  }
  return { faixas, video, depoisDoVideo, lacuna }
}

// ───── varrer os dados soltos ─────

function reconhecerVideo(v, b, p, fim) {
  return v.tipo === 'prores' ? quadroProRes(b, p, fim) : quadroNal(b, p, fim, v.opts)
}

/**
 * Lê os dados do clipe quebrado e reconhece os pedaços.
 * @returns {{ amostras: Map<faixa, object[]>, fimUtil: number, ignorados: number, paramsDiferentes: boolean }}
 */
async function varrerDados(fh, ini, fim, plano, { onProgress, signal } = {}) {
  const { faixas, video } = plano
  const fixos = faixas.filter((x) => x.tipo === 'fixo')
  const amostras = new Map(faixas.map((x) => [x, []]))
  let buf = new Uint8Array(0)
  let base = ini // posição no arquivo de buf[0]
  const carregar = async (desde) => {
    const n = Math.min(JANELA, fim - desde)
    buf = new Uint8Array(n)
    let lidos = 0
    while (lidos < n) {
      const { bytesRead } = await fh.read(buf, lidos, n - lidos, desde + lidos)
      if (!bytesRead) break
      lidos += bytesRead
    }
    buf = buf.subarray(0, lidos)
    base = desde
  }
  await carregar(ini)
  let p = ini
  let fimUtil = ini
  let ignorados = 0
  let videoSeguidos = 0
  let paramsVistos = false
  let paramsDiferentes = false
  let ultimoAviso = 0
  const fimBuf = () => base + buf.length

  const videoEm = (pos) => {
    const r = reconhecerVideo(video, buf, pos - base, buf.length)
    return r && (pos + r.tam <= fimBuf()) ? r : null
  }
  // Pedaço fixo em `pos` vale se o que vem depois dele é reconhecível (vídeo, outro fixo) ou é o fim dos dados.
  const fixoEm = (pos) => {
    for (const fx of fixos) {
      for (const bytes of fx.tamanhosPedaco) {
        const depois = pos + bytes
        if (depois > fim) continue
        if (depois === fim || depois + 8 > fimBuf()) {
          if (depois === fim) return { fx, bytes }
          continue
        }
        if (videoEm(depois)) return { fx, bytes }
        for (const outro of fixos) if (outro !== fx && outro.tamanhosPedaco.some((t) => depois + t <= fim && videoEm(depois + t))) return { fx, bytes }
      }
    }
    return null
  }

  while (p < fim) {
    if (signal?.aborted) throw Object.assign(new Error('parado'), { name: 'AbortError' })
    if (p - base > buf.length - FOLGA && fimBuf() < fim) await carregar(p)
    if (onProgress && p - ultimoAviso > 8 * 1024 * 1024) {
      ultimoAviso = p
      onProgress((p - ini) / (fim - ini))
    }
    // Depois de um pedaço de vídeo completo (pelo padrão da referência), o próximo costuma ser outra faixa.
    const preferirFixo = fixos.length && videoSeguidos >= video.porPedaco
    let feito = false
    for (const tentativa of preferirFixo ? ['fixo', 'video'] : ['video', 'fixo']) {
      if (tentativa === 'video') {
        const r = videoEm(p)
        if (!r) continue
        if (video.tipo === 'nal' && !paramsVistos) {
          const ps = parametrosNoQuadro(buf, p - base, r.tam, video.opts)
          if (ps.length) {
            paramsVistos = true
            const cfg = video.f.nal?.config
            if (cfg && !ps.every((x) => contem(cfg, x.dados))) paramsDiferentes = true
          }
        }
        amostras.get(video).push({ pos: p, tam: r.tam, chave: r.chave, ord: video.ordem ? video.ordem.quadro(buf, p - base, r.tam) : undefined })
        p += r.tam
        videoSeguidos++
        feito = true
        break
      }
      const r = fixoEm(p)
      if (!r) continue
      const n = Math.floor(r.bytes / r.fx.tamAmostra)
      amostras.get(r.fx).push({ pos: p, tam: r.fx.tamAmostra, n, bytes: r.bytes })
      p += r.bytes
      videoSeguidos = 0
      feito = true
      break
    }
    if (feito) {
      fimUtil = p
      continue
    }
    // Trecho que não se reconhece (áudio AAC, metadado variável, lixo): procura o próximo quadro de vídeo. Com o
    // tamanho dos pedaços opacos da referência, procura primeiro nessa faixa e confere que depois do quadro vem outro
    // reconhecível (vídeo, fixo, ou outro trecho do mesmo tamanho e então vídeo).
    if (fimBuf() < fim && p - base > buf.length - FOLGA - BUSCA_MAX) await carregar(p)
    const depoisOk = (q, r, fundo = 1) => {
      const d = q + r.tam
      if (d >= fim || d + 8 > fimBuf()) return d >= fim
      if (videoEm(d) || fixoEm(d)) return true
      if (!plano.lacuna) return false
      if (fundo <= 0) return true // dois quadros encadeados por trechos do tamanho certo
      for (let k = d + plano.lacuna.min; k <= Math.min(fimBuf() - 8, d + plano.lacuna.max + 64); k++) {
        const r2 = videoEm(k)
        if (r2 && depoisOk(k, r2, fundo - 1)) return true
      }
      return false
    }
    let achou = -1
    const faixasBusca = plano.lacuna ? [[p + Math.max(1, plano.lacuna.min - 64), p + plano.lacuna.max + 64], [p + 1, p + BUSCA_MAX]] : [[p + 1, p + BUSCA_MAX]]
    for (const [a, z] of faixasBusca) {
      const limite = Math.min(fim, z, fimBuf() - 8)
      for (let q = a; q < limite; q++) {
        const r = videoEm(q)
        if (r && depoisOk(q, r)) {
          achou = q
          break
        }
      }
      if (achou >= 0) break
    }
    if (achou < 0) break
    ignorados += achou - p
    p = achou
    videoSeguidos = 0
  }
  onProgress?.(1)
  return { amostras, fimUtil, ignorados, paramsDiferentes }
}

function contem(a, b) {
  outer: for (let i = 0; i + b.length <= a.length; i++) {
    for (let k = 0; k < b.length; k++) if (a[i + k] !== b[k]) continue outer
    return true
  }
  return false
}

// ───── montar o índice novo ─────

function full(versao, flags) {
  return new Corpo().u8(versao).u8((flags >> 16) & 255).u8((flags >> 8) & 255).u8(flags & 255)
}

function rle(valores) {
  const out = []
  for (const v of valores) {
    const ult = out[out.length - 1]
    if (ult && ult.v === v) ult.n++
    else out.push({ v, n: 1 })
  }
  return out
}

/** Tabelas novas de uma faixa a partir das amostras achadas. `desloc` = posição antiga → nova. */
function tabelas(plano, x, achadas, desloc) {
  const pedacos = []
  const tamanhos = []
  const chaves = []
  let nAmostras = 0
  if (x.tipo === 'fixo') {
    for (const a of achadas) {
      pedacos.push({ pos: desloc(a.pos), n: a.n })
      nAmostras += a.n
    }
  } else {
    // Vídeo: cada quadro é um pedaço (simples e válido).
    for (const a of achadas) {
      pedacos.push({ pos: desloc(a.pos), n: 1 })
      tamanhos.push(a.tam)
      if (a.chave) chaves.push(nAmostras + 1)
      nAmostras++
    }
  }
  const grande = pedacos.some((c) => c.pos > 0xffffffff)
  const stco = full(0, 0).u32(pedacos.length)
  for (const c of pedacos) grande ? stco.u64(c.pos) : stco.u32(c.pos)
  const stsc = full(0, 0)
  const runs = rle(pedacos.map((c) => c.n))
  stsc.u32(runs.length)
  let primeiro = 1
  for (const r of runs) {
    stsc.u32(primeiro).u32(r.v).u32(1)
    primeiro += r.n
  }
  const stsz = full(0, 0)
  if (x.tipo === 'fixo') stsz.u32(x.tamAmostra).u32(nAmostras)
  else {
    stsz.u32(0).u32(tamanhos.length)
    for (const t of tamanhos) stsz.u32(t)
  }
  const stts = full(0, 0).u32(1).u32(nAmostras).u32(x.dur)
  const nos = [
    { tipo: 'stts', dados: stts.fim() },
    { tipo: 'stsc', dados: stsc.fim() },
    { tipo: 'stsz', dados: stsz.fim() },
    { tipo: grande ? 'co64' : 'stco', dados: stco.fim() },
  ]
  if (x.tipo !== 'fixo' && x.f.temStss) {
    const stss = full(0, 0).u32(chaves.length)
    for (const k of chaves) stss.u32(k)
    nos.push({ tipo: 'stss', dados: stss.fim() })
  }
  // B-frames: a ordem de exibição lida de cada quadro (POC); sem ela, o padrão do GOP da referência.
  let atraso = null
  const lidos = x.tipo !== 'fixo' && x.f.temCtts && x.ordem ? deslocamentos(achadas.map((a) => a.ord), x.dur) : null
  if (lidos) {
    atraso = lidos.atraso
    const runs2 = rle(lidos.cts)
    const ctts = full(0, 0).u32(runs2.length)
    for (const r of runs2) ctts.u32(r.n).i32(r.v)
    nos.push({ tipo: 'ctts', dados: ctts.fim() })
  } else if (x.tipo !== 'fixo' && x.gop && achadas.length) {
    const cts = []
    let i = 0
    let gop = -1
    for (const a of achadas) {
      if (a.chave || gop < 0) {
        gop++
        i = 0
      }
      const padrao = gop === 0 && x.ctsInicio && achadas[0].chave ? x.ctsInicio : x.gop
      cts.push(padrao[Math.min(i, padrao.length - 1)] ?? 0)
      i++
    }
    const runs2 = rle(cts)
    const ctts = full(0, 0).u32(runs2.length)
    for (const r of runs2) ctts.u32(r.n).i32(r.v)
    nos.push({ tipo: 'ctts', dados: ctts.fim() })
  }
  return { nos, nAmostras, duracao: nAmostras * x.dur, atraso }
}

function trocarDuracaoMdhd(d, dur) {
  const out = d.slice()
  const v = new DataView(out.buffer)
  if (out[0] === 1) {
    v.setUint32(24, Math.floor(dur / 2 ** 32))
    v.setUint32(28, dur >>> 0)
  } else v.setUint32(16, Math.min(dur, 0xffffffff))
  return out
}

function trocarDuracaoTkhd(d, dur) {
  const out = d.slice()
  const v = new DataView(out.buffer)
  if (out[0] === 1) {
    v.setUint32(28, Math.floor(dur / 2 ** 32))
    v.setUint32(32, dur >>> 0)
  } else v.setUint32(20, Math.min(dur, 0xffffffff))
  return out
}

function trocarMvhd(d, dur, criadoEm) {
  const out = d.slice()
  const v = new DataView(out.buffer)
  const t = Math.floor(criadoEm / 1000) + EPOCA_MOV
  if (out[0] === 1) {
    for (const o of [4, 12]) {
      v.setUint32(o, Math.floor(t / 2 ** 32))
      v.setUint32(o + 4, t >>> 0)
    }
    v.setUint32(24, Math.floor(dur / 2 ** 32))
    v.setUint32(28, dur >>> 0)
  } else {
    v.setUint32(4, t >>> 0)
    v.setUint32(8, t >>> 0)
    v.setUint32(16, Math.min(dur, 0xffffffff))
  }
  return out
}

function trocarElst(d, durMovie, inicioMidia = null) {
  const out = d.slice()
  const v = new DataView(out.buffer)
  const n = v.getUint32(4)
  if (n !== 1) return out
  if (out[0] === 1) {
    v.setUint32(8, Math.floor(durMovie / 2 ** 32))
    v.setUint32(12, durMovie >>> 0)
    if (inicioMidia != null) {
      v.setUint32(16, Math.floor(inicioMidia / 2 ** 32))
      v.setUint32(20, inicioMidia >>> 0)
    }
  } else {
    v.setUint32(8, Math.min(durMovie, 0xffffffff))
    if (inicioMidia != null) v.setInt32(12, inicioMidia)
  }
  return out
}

function montarMoov(ref, plano, achadasPorFaixa, desloc, criadoEm) {
  const ts = ref.mvhd.timescale
  const traks = []
  let durMovie = 0
  const usadas = []
  for (const x of plano.faixas) {
    const achadas = achadasPorFaixa.get(x) || []
    if (x.tipo === 'opaco' || !achadas.length) continue
    const t = tabelas(plano, x, achadas, desloc)
    const durMov = Math.round((t.duracao * ts) / x.f.timescale)
    durMovie = Math.max(durMovie, durMov)
    // Clona o trak da referência trocando as tabelas e as durações.
    const trak = structuredClone(x.f.trak)
    trak.filhos = trak.filhos.filter((n) => n.tipo !== 'tref')
    const tkhd = filho(trak, 'tkhd')
    tkhd.dados = trocarDuracaoTkhd(tkhd.dados, durMov)
    const elst = caminho(trak, 'edts', 'elst')
    if (elst) elst.dados = trocarElst(elst.dados, durMov, t.atraso)
    const mdhd = caminho(trak, 'mdia', 'mdhd')
    mdhd.dados = trocarDuracaoMdhd(mdhd.dados, t.duracao)
    const stbl = caminho(trak, 'mdia', 'minf', 'stbl')
    const manter = stbl.filhos.filter((n) => n.tipo === 'stsd' || n.tipo === 'sgpd' || n.tipo === 'sbgp' ? n.tipo === 'stsd' : false)
    stbl.filhos = [...manter, ...t.nos]
    traks.push(trak)
    usadas.push({ x, ...t })
  }
  const mvhdNo = filho(ref.moov, 'mvhd')
  const moov = { tipo: 'moov', filhos: [{ tipo: 'mvhd', dados: trocarMvhd(mvhdNo.dados, durMovie, criadoEm) }, ...traks] }
  return { moov, usadas, durMovie }
}

// ───── juntar tudo ─────

/**
 * Conserta `quebrado` usando `referencia` e grava um arquivo novo em `saida`.
 * @returns {Promise<{ duracaoS: number, quadros: number, faixas: object[], perdidas: object[], ignorados: number, avisos: string[] }>}
 */
export async function consertarVideo({ quebrado, referencia, saida, onProgress, signal } = {}) {
  if (!quebrado || !referencia || !saida) throw new ErroConserto('entrada', 'Faltou o clipe, a referência ou onde salvar.')
  if (saida === quebrado) throw new ErroConserto('entrada', 'O conserto grava um arquivo novo: escolha outro nome.')
  const ref = await lerReferencia(referencia)
  const plano = planejar(ref)
  const fh = await fs.open(quebrado, 'r')
  let resultado
  try {
    const st = await fh.stat()
    const topo = await caixasDoTopo(fh, st.size)
    if (topo.some((c) => c.tipo === 'moov' && c.ini + c.tam <= st.size)) {
      throw new ErroConserto('inteiro', 'Este clipe já tem o índice. Se não abre, o problema é outro (o conserto não mexe nele).')
    }
    const mdat = topo.find((c) => c.tipo === 'mdat')
    let ini
    let fim
    if (mdat) {
      ini = mdat.ini + mdat.cab
      fim = Math.min(st.size, mdat.tam > mdat.cab ? mdat.ini + mdat.tam : st.size)
      if (fim <= ini) fim = st.size
    } else {
      // Sem cabeçalho mdat reconhecível: começa logo depois do que deu para ler (ftyp, wide, free).
      ini = topo.length ? topo[topo.length - 1].ini + topo[topo.length - 1].tam : 0
      fim = st.size
    }
    // Sobra depois do mdat (moov começado e não terminado): os dados de vídeo podem ir até o fim do arquivo.
    if (fim < st.size && !topo.some((c) => c.ini >= fim && c.tipo !== 'moov')) fim = st.size
    const v = await varrerDados(fh, ini, fim, plano, { onProgress: (f) => onProgress?.({ fase: 'lendo', frac: f }), signal })
    const quadros = v.amostras.get(plano.video).length
    const reconhecidos = [...v.amostras.values()].flat().reduce((t, a) => t + (a.bytes ?? a.tam), 0)
    // Referência de outro modo acha um ou outro "quadro" por acaso: se quase nada foi reconhecido, não serve.
    if (quadros && (quadros < 3 || reconhecidos < (fim - ini) * 0.3) && !plano.lacuna) {
      throw new ErroConserto('referencia_diferente', 'A referência não parece ser do mesmo modo de gravação deste clipe. Use um clipe da mesma câmera, com a mesma resolução, os mesmos quadros por segundo e o mesmo formato.')
    }
    if (quadros && quadros < 3) {
      throw new ErroConserto('referencia_diferente', 'A referência não parece ser do mesmo modo de gravação deste clipe. Use um clipe da mesma câmera, com a mesma resolução, os mesmos quadros por segundo e o mesmo formato.')
    }
    if (!quadros) {
      throw new ErroConserto('nada', 'Não achei quadros de vídeo do mesmo formato da referência. Confira se a referência é da mesma câmera, no mesmo modo.')
    }
    const usados = [...v.amostras.values()].flat()
    const primeiroUsado = Math.min(...usados.map((a) => a.pos))
    const fimUsado = Math.max(...usados.map((a) => a.pos + (a.bytes ?? a.tam)))

    // Arquivo novo: ftyp + mdat (os dados de primeiroUsado até fimUsado, copiados) + moov.
    const ftypBytes = await lerFtyp(fh, topo, ref)
    const dadosLen = fimUsado - primeiroUsado
    const mdatCab = new Uint8Array(16)
    const dv = new DataView(mdatCab.buffer)
    dv.setUint32(0, 1)
    mdatCab.set([0x6d, 0x64, 0x61, 0x74], 4)
    dv.setUint32(8, Math.floor((dadosLen + 16) / 2 ** 32))
    dv.setUint32(12, (dadosLen + 16) >>> 0)
    const novoIni = ftypBytes.length + 16
    const desloc = (pos) => novoIni + (pos - primeiroUsado)
    const { moov, usadas, durMovie } = montarMoov(ref, plano, v.amostras, desloc, st.mtimeMs)
    const moovBytes = escrever(moov)

    const out = await fs.open(saida, 'wx')
    try {
      await out.write(ftypBytes, 0, ftypBytes.length, 0)
      await out.write(mdatCab, 0, 16, ftypBytes.length)
      let escrito = 0
      let pos = novoIni
      const rs = createReadStream(null, { fd: fh.fd, start: primeiroUsado, end: fimUsado - 1, autoClose: false, highWaterMark: 4 * 1024 * 1024 })
      for await (const pedaco of rs) {
        if (signal?.aborted) {
          rs.destroy()
          throw Object.assign(new Error('parado'), { name: 'AbortError' })
        }
        await out.write(pedaco, 0, pedaco.length, pos)
        pos += pedaco.length
        escrito += pedaco.length
        onProgress?.({ fase: 'gravando', frac: escrito / dadosLen })
      }
      await out.write(moovBytes, 0, moovBytes.length, pos)
    } catch (err) {
      await out.close().catch(() => {})
      await fs.rm(saida, { force: true })
      throw err
    }
    await out.close()

    const faixasV = usadas.map((u) => ({ tipo: u.x.f.handler === 'vide' ? 'video' : u.x.f.handler === 'soun' ? 'audio' : 'dados', codec: u.x.f.codec, amostras: u.nAmostras, duracaoS: u.duracao / u.x.f.timescale }))
    const perdidas = plano.faixas
      .filter((x) => x.tipo === 'opaco' || !(v.amostras.get(x) || []).length)
      .map((x) => ({ tipo: x.f.handler === 'vide' ? 'video' : x.f.handler === 'soun' ? 'audio' : 'dados', codec: x.f.codec, motivo: x.motivo || 'Não achei dados desta faixa no clipe.' }))
    const avisos = []
    if (perdidas.some((p) => p.tipo === 'audio')) avisos.push('O vídeo volta sem som (o áudio deste modo não dá para remontar).')
    if (v.paramsDiferentes) avisos.push('A configuração de vídeo do clipe é diferente da referência. Se a imagem sair estranha, use uma referência gravada no mesmo modo.')
    if (fim - v.fimUtil > 1024 * 1024) avisos.push('Os últimos segundos podem faltar: o fim do arquivo não estava completo.')
    resultado = { duracaoS: durMovie / ref.mvhd.timescale, quadros, faixas: faixasV, perdidas, ignorados: v.ignorados, avisos, bytes: dadosLen }
  } finally {
    await fh.close()
  }
  return resultado
}

async function lerFtyp(fh, topo, ref) {
  const f = topo.find((c) => c.tipo === 'ftyp')
  if (f && f.tam < 4096) {
    const b = new Uint8Array(f.tam)
    await fh.read(b, 0, f.tam, f.ini)
    return b
  }
  return ref.ftypBytes || escrever({ tipo: 'ftyp', dados: Uint8Array.from([0x71, 0x74, 0x20, 0x20, 0, 0, 2, 0, 0x71, 0x74, 0x20, 0x20]) })
}

export { arvore, lerTipo }
