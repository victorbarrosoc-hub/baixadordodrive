// Aba Criar: as ferramentas do app do computador, no celular.
//   Frames  o vídeo final (direto do Drive ou da galeria) vira frames escolhidos com o mesmo bom senso do computador,
//           por cena, e posts (tríade, grade, polaroid, box, cinema, contato, carrossel). Desce do Drive, fica no
//           celular (galeria/arquivos) e sobe de volta para o Drive, numa pasta organizada ao lado do vídeo.
// O trabalho fica nesta aba (que não desmonta): trocar de aba e voltar não perde nada.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js'
import { closeSheet, getState, openSheet, setState, setTab, toast, useApp } from '../lib/state.js'
import { streamReady, streamUrl } from '../lib/stream.js'
import { createFolder, driveCall } from '../lib/drive.js'
import { engine } from '../lib/uploader.js'
import { framesPedidos, pedirFrames, tentarDeNovo } from '../lib/proxies.js'
import { bytes, count } from '../lib/format.js'
import { abrirVideo, amostrar, baseDoNome, escolher, fechar, nomeDoFrame, pastaDaCena, timecode, tirar } from '../lib/frames/celular.js'
import { celularAbre, lerCodec, porqueNaoAbre, rotuloCodec } from '../lib/frames/codec.js'
import { faixa } from '../lib/psd.js'
import { findProxy, mayPlay } from '../lib/browse.js'
import { FUNDOS, LAYOUTS, ZOOM_MAX, desenharPost, enquadreDe, fatiar, frameNoPonto, layoutPorId, moverEnquadre } from '../lib/frames/posts.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx } from './ui.js'
import { BotaoGrande, Destaque, Opcoes, Passo, Pilulas, Stats } from './kit.js'
import { TopoMarca } from './main.js'

const QUANTOS = [6, 12, 24, 36]
const GRANDE = 1.5e9 // acima disso, pelo celular demora: sugere o computador
// Até isso, o vídeo do Drive desce inteiro uma vez (seguido é rápido) e a análise pula no próprio celular. Acima, lê
// pelo stream, que espera a internet a cada pulo: menos pontos e três leitores ao mesmo tempo.
const BAIXAR_ATE = 150e6
const nomeSemExt = (n) => String(n || '').replace(/\.[^.]{1,6}$/, '')
const tc = (s) => String(s || '').replace(/-/g, ':')

// ───── o trabalho (fica no módulo: a aba some e volta sem perder) ─────

let job = null // { video, fase, frac, cenas, frames: [{ id, t, tc, cena, blob, url, mini, sel }], erro, ac }
const ouvintes = new Set()
const mudou = () => ouvintes.forEach((f) => f())
function useJob() {
  const [, set] = useState(0)
  useEffect(() => {
    const f = () => set((x) => x + 1)
    ouvintes.add(f)
    return () => ouvintes.delete(f)
  }, [])
  return job
}

function limpar() {
  job?.ac?.abort()
  for (const f of job?.frames || []) {
    URL.revokeObjectURL(f.url)
    URL.revokeObjectURL(f.miniUrl)
  }
  if (job?.video?.blobUrl) URL.revokeObjectURL(job.video.blobUrl)
  if (job?.video?.baixado) URL.revokeObjectURL(job.video.baixado)
  job = null
  mudou()
}

/** Chamado pela aba Drive (seleção → Frames): abre a aba Criar com o vídeo escolhido. */
export function framesDoDrive(file) {
  limpar()
  setState({ escolher: null })
  job = { video: { origem: 'drive', file, nome: file.name, size: Number(file.size) || 0 }, fase: 'ajustes' }
  detectar(job)
  setState({ criarTela: 'frames' })
  setTab('criar')
  mudou()
}

/**
 * Lê o codec do vídeo escolhido (só o cabeçalho: alguns KB do Drive ou do arquivo) e guarda em video.codec. Assim a
 * tela diz antes o que tem dentro do MP4 e, se o celular com certeza não abre, já vai para o proxy ou o computador.
 */
function detectar(alvo) {
  const v = alvo.video
  const ler = v.origem === 'drive' ? (a, b) => faixa(v.file.id, a, b) : async (a, b) => new Uint8Array(await v.arquivo.slice(a, b).arrayBuffer())
  v.codecLido = lerCodec(ler, v.size || null)
    .catch(() => null)
    .then((c) => {
      v.codec = c
      if (job === alvo) mudou()
      return c
    })
}

/** O celular não abre (pelo codec): o erro com o motivo de verdade. */
const erroDoCodec = (codec, nome, resto = '') => Object.assign(new Error(`${porqueNaoAbre(codec, nome)}${resto}`), { formato: true })

async function rodar(quantidade, formato) {
  const ac = new AbortController()
  Object.assign(job, { fase: 'lendo', frac: 0, erro: null, ac, frames: [], cenas: [], formato, baixou: false })
  mudou()
  const passo = (fase, frac) => {
    if (job?.ac !== ac) return
    job.fase = fase
    job.frac = frac
    mudou()
  }
  let v
  let extras = []
  try {
    job.fonte = null
    if (job.video.origem === 'drive') {
      const { file } = job.video
      const codec = await job.video.codecLido
      const size = Number(file.size) || 0
      if (job.video.baixado || (size > 0 && size <= BAIXAR_ATE && mayPlay(file) && celularAbre(codec) !== false)) {
        job.baixou = true
        if (!job.video.baixado) {
          passo('baixando', 0)
          job.video.baixado = URL.createObjectURL(await baixarDoDrive(file, ac.signal, (f) => passo('baixando', f)))
        }
        passo('lendo', 0)
        v = await abrirVideo(job.video.baixado, { signal: ac.signal }).catch((err) => {
          if (err?.tipo !== 'formato') throw err
          return null
        })
      }
      if (!v) {
        if (!(await streamReady())) throw new Error('Abra o app pelo ícone da tela de início (ou recarregue) para ler vídeos do Drive.')
        v = await abrirDoDrive(file, ac.signal, codec, { original: !job.baixou })
      }
    } else {
      const codec = await job.video.codecLido
      if (celularAbre(codec) === false) throw erroDoCodec(codec, job.video.nome)
      v = await abrirVideo(job.video.blobUrl, { signal: ac.signal }).catch((err) => {
        throw err?.tipo === 'formato' && codec && celularAbre(codec) !== true ? erroDoCodec(codec, job.video.nome) : err
      })
    }
    // Mais leitores no mesmo endereço leem outros trechos juntos: pelo stream, cada pulo espera a internet, e três
    // esperas juntas custam quase o mesmo que uma; baixado, o celular decodifica em paralelo. Em 4K, só um a mais.
    extras = await maisLeitores(v, v.videoWidth * v.videoHeight > 2.2e6 ? 1 : 2, ac.signal)
    const pelaRede = !(v.currentSrc || v.src).startsWith('blob:')
    const a = await amostrar([v, ...extras], { signal: ac.signal, max: pelaRede ? 120 : 240, onProgress: (f) => passo('lendo', f) })
    for (const x of extras.splice(0)) fechar(x)
    const r = escolher(a, quantidade)
    job.cenas = r.cenas
    job.descartes = r.descartes
    const base = baseDoNome(job.video.nome)
    const tipo = formato === 'png' ? 'image/png' : 'image/jpeg'
    for (const [i, f] of r.frames.entries()) {
      passo('frames', i / r.frames.length)
      const x = await tirar(v, f.t, { tipo, signal: ac.signal })
      const fr = { id: `F${String(i + 1).padStart(3, '0')}`, t: f.t, cena: f.cena, nota: f.nota, tc: timecode(f.t), blob: x.blob, url: URL.createObjectURL(x.blob), miniUrl: URL.createObjectURL(x.mini), largura: x.largura, altura: x.altura, sel: 0 }
      fr.nome = nomeDoFrame(base, fr, formato === 'png' ? 'png' : 'jpg')
      job.frames.push(fr)
    }
    passo('pronto', 1)
  } catch (err) {
    if (job?.ac !== ac) return
    if (err?.name === 'AbortError') job.fase = 'ajustes'
    else Object.assign(job, { fase: 'erro', erro: err?.message || 'Não deu para terminar.', erroFormato: Boolean(err?.formato || err?.tipo === 'formato') })
    mudou()
  } finally {
    if (v) fechar(v)
    for (const x of extras) fechar(x)
  }
}

async function maisLeitores(v, n, signal) {
  const r = await Promise.allSettled(Array.from({ length: n }, () => abrirVideo(v.currentSrc || v.src, { signal })))
  return r.filter((x) => x.status === 'fulfilled').map((x) => x.value)
}

/** O vídeo inteiro do Drive, de uma vez (um download seguido é muito mais rápido que centenas de pulos pela rede). */
async function baixarDoDrive(file, signal, onProgress) {
  const res = await driveCall(`/files/${encodeURIComponent(file.id)}`, { query: { alt: 'media', supportsAllDrives: true }, raw: true, signal, retries: 2 })
  const total = Number(file.size) || 0
  let got = 0
  const contando = new TransformStream({
    transform(pedaco, ctl) {
      got += pedaco.byteLength
      if (total) onProgress(Math.min(1, got / total))
      ctl.enqueue(pedaco)
    },
  })
  // O navegador monta o arquivo (sem juntar pedaços na memória do JS).
  return new Response(res.body.pipeThrough(contando), { headers: { 'Content-Type': file.mimeType || 'video/mp4' } }).blob()
}

/**
 * O original direto do Drive; se o celular não abre o formato (ProRes, MXF, H.264 10-bit 4:2:2 de câmera), o proxy
 * que já está no Drive (a cópia leve do app ou da câmera). Sem nenhum dos dois: erro com "Pedir ao computador".
 * Quando o codec já diz que não abre, nem tenta o original (era só espera).
 */
async function abrirDoDrive(file, signal, codec = null, { original = true } = {}) {
  let erro = null
  if (original && mayPlay(file) && celularAbre(codec) !== false) {
    try {
      return await abrirVideo(streamUrl(file), { signal })
    } catch (err) {
      if (err?.name === 'AbortError' || err?.tipo === 'rede') throw err
      erro = err
    }
  }
  const proxy = await findProxy(file, [], signal).catch(() => null)
  if (proxy) {
    const v = await abrirVideo(streamUrl(proxy), { signal })
    job.fonte = { tipo: 'proxy', nome: proxy.name, largura: v.videoWidth, altura: v.videoHeight }
    return v
  }
  if (codec && celularAbre(codec) !== true) throw Object.assign(erroDoCodec(codec, file.name, ' E ele ainda não tem proxy no Drive.'), { causa: erro })
  throw Object.assign(new Error('O celular não abre o formato deste vídeo, e ele ainda não tem proxy no Drive.'), { formato: true, causa: erro })
}

// ───── salvar e subir ─────

/** No celular: a folha de compartilhar (Salvar imagem / Salvar em Arquivos); sem ela, um download por arquivo. */
async function salvarNoCelular(arquivos) {
  const files = arquivos.map((a) => new File([a.blob], a.nome, { type: a.blob.type }))
  try {
    if (navigator.canShare?.({ files })) {
      await navigator.share({ files })
      return true
    }
  } catch (err) {
    if (err?.name === 'AbortError') return false
  }
  for (const f of files) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(f)
    a.download = f.name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
    await new Promise((r) => setTimeout(r, 300))
  }
  return true
}

/** Sobe para o Drive: "<Vídeo> — Frames/Cena 03 — …/…" e "Posts/". `pai`: { id, name, driveId, path }. */
async function subirProDrive({ pai, frames = [], posts = [], cenas }) {
  const nome = `${nomeSemExt(job.video.nome)} — Frames`
  const raiz = job.pastaDrive?.paiId === pai.id ? job.pastaDrive : null
  const pasta = raiz || { ...(await createFolder(nome, pai.id)), paiId: pai.id, subs: {} }
  job.pastaDrive = pasta
  const caminho = [...(pai.path || [{ id: pai.id, name: pai.name }]), { id: pasta.id, name: pasta.name }]
  const sub = async (rotulo) => {
    if (!pasta.subs[rotulo]) pasta.subs[rotulo] = await createFolder(rotulo, pasta.id)
    const s = pasta.subs[rotulo]
    return { id: s.id, name: s.name, driveId: s.driveId || pai.driveId || null, path: [...caminho, { id: s.id, name: s.name }] }
  }
  const porPasta = new Map()
  for (const f of frames) {
    const c = cenas.find((x) => x.n === f.cena)
    const rot = pastaDaCena(f.cena, c?.nome || c?.tags.join(', '))
    if (!porPasta.has(rot)) porPasta.set(rot, [])
    porPasta.get(rot).push(new File([f.blob], f.nome, { type: f.blob.type }))
  }
  if (posts.length) porPasta.set('Posts', posts.map((p) => new File([p.blob], p.nome, { type: p.blob.type })))
  let n = 0
  for (const [rot, files] of porPasta) {
    engine.addFiles(files, await sub(rot))
    n += files.length
  }
  return { n, pasta: pasta.name }
}

async function escolherPai() {
  const v = job.video
  if (v.origem === 'drive' && v.file.parents?.[0]) return { id: v.file.parents[0], name: 'a pasta do vídeo', driveId: v.file.driveId || null }
  return new Promise((resolve) => {
    openSheet('folders', {
      verb: 'Subir aqui',
      onChoose: (f) => {
        closeSheet()
        resolve(f)
      },
      onCancel: () => {
        closeSheet()
        resolve(null)
      },
    })
  })
}

async function subir(itens) {
  const pai = await escolherPai()
  if (!pai) return
  try {
    const r = await subirProDrive({ pai, cenas: job.cenas, ...itens })
    toast(`Subindo ${count(r.n)} ${r.n === 1 ? 'arquivo' : 'arquivos'} para “${r.pasta}”`, { tone: 'success', ms: 4000 })
  } catch (err) {
    toast(err?.message || 'Não consegui criar a pasta no Drive.', { tone: 'error' })
  }
}

// ───── telas ─────

function Hub({ onFrames, onCalc, temCalc }) {
  return html`<div class="cr-hub">
    <button type="button" class="cr-ferr k-entra" style="--i:1" onClick=${onFrames}>
      <span class="cr-ferr-art is-frames" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="cr-ferr-txt"><b>Frames</b><span>Do vídeo final aos frames por cena e aos posts.</span></span>
      <${Icon} name="chevron-right" size=${18} />
    </button>
    ${temCalc
      ? html`<button type="button" class="cr-ferr k-entra" style="--i:2" onClick=${onCalc}>
          <span class="cr-ferr-art is-calc" aria-hidden="true"><i></i></span>
          <span class="cr-ferr-txt"><b>Calculadora</b><span>Quanto cabe no cartão e quanto HD levar.</span></span>
          <${Icon} name="chevron-right" size=${18} />
        </button>`
      : null}
  </div>`
}

function Escolher() {
  const input = useRef(null)
  const daGaleria = (e) => {
    const f = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!f) return
    limpar()
    job = { video: { origem: 'galeria', nome: f.name, size: f.size, arquivo: f, blobUrl: URL.createObjectURL(f) }, fase: 'ajustes' }
    detectar(job)
    mudou()
  }
  return html`<div class="k-opcoes cr-origens" style="--n:2">
    <button
      type="button"
      class="k-opcao"
      onClick=${() => {
        setState({ escolher: { para: 'frames' } })
        setTab('drive')
      }}
    >
      <span class="k-opcao-ic"><${Icon} name="drive" size=${18} strokeWidth=${1.9} /></span>
      <b>Do Drive</b>
      <span>Abra a pasta e toque no vídeo</span>
      <span class="cr-tag">Desce</span>
    </button>
    <button type="button" class="k-opcao is-up" onClick=${() => input.current?.click()}>
      <span class="k-opcao-ic"><${Icon} name="film" size=${18} strokeWidth=${1.9} /></span>
      <b>Da galeria</b>
      <span>Um vídeo deste celular</span>
    </button>
    <input ref=${input} type="file" accept="video/*" hidden onChange=${daGaleria} />
  </div>`
}

function Ajustes({ j }) {
  const [q, setQ] = useState(12)
  const [fmt, setFmt] = useState('jpg')
  const grande = j.video.size > GRANDE
  const codec = j.video.codec
  const naoAbre = celularAbre(codec) === false
  const semFormato = j.video.origem === 'drive' && (!mayPlay(j.video.file) || naoAbre)
  return html`<div class="cr-passos">
    <${Passo} n=${1} titulo="O vídeo final" i=${1}>
      <div class="cr-video">
        <span class="cr-origem-ic"><${Icon} name=${j.video.origem === 'drive' ? 'drive' : 'film'} size=${20} /></span>
        <span><b>${j.video.nome}</b><small>${j.video.origem === 'drive' ? 'Direto do Drive' : 'Da galeria'}${j.video.size ? ` · ${bytes(j.video.size)}` : ''}${codec ? ` · ${rotuloCodec(codec)}` : ''}</small></span>
        <button type="button" class="link-btn" onClick=${limpar}>Trocar</button>
      </div>
      ${semFormato ? html`<p class="cr-aviso"><${Icon} name="info" size=${15} />${naoAbre ? porqueNaoAbre(codec, j.video.nome) : 'Este aparelho não abre o formato do original.'} Os frames saem do proxy do Drive, se houver; em alta, peça ao computador.</p>` : null}
      ${naoAbre && j.video.origem !== 'drive' ? html`<p class="cr-aviso"><${Icon} name="info" size=${15} />${porqueNaoAbre(codec, j.video.nome)} Suba o vídeo para o Drive (aba Início) e peça os frames ao computador.</p>` : null}
      ${grande && !semFormato ? html`<p class="cr-aviso"><${Icon} name="info" size=${15} />Vídeo pesado: pelo celular demora e depende da internet. O app do computador faz mais rápido, com takes.</p>` : null}
    </${Passo}>
    <${Passo} n=${2} titulo="Frames" frase="Os melhores de cada cena, no tamanho do vídeo." i=${2}>
      <div class="cr-quant">
        <div class="cr-quant-num"><b>${q}</b><span>frames</span></div>
        <${Pilulas} label="Quantos frames" valor=${q} onEscolher=${setQ} itens=${QUANTOS.map((n) => ({ value: n, label: String(n) }))} />
      </div>
      <${Opcoes}
        label="Formato"
        valor=${fmt}
        onEscolher=${setFmt}
        colunas=${2}
        itens=${[
          { value: 'jpg', titulo: 'JPG', sub: 'Leve, qualidade máxima' },
          { value: 'png', titulo: 'PNG', sub: 'Sem perda' },
        ]}
      />
      <${BotaoGrande} icone="sparkle" onClick=${() => rodar(q, fmt)} dica=${html`Escuro, desfocado e repetido ficam de fora.`}>Fazer os frames</${BotaoGrande}>
    </${Passo}>
    ${j.video.origem === 'drive'
      ? html`<${Passo} icone="laptop" cor="up" titulo="Completo, no computador" frase="Com takes em 9:16 ou ProRes. Sobe pro Drive sozinho." i=${3}>
          <${NoComputador} file=${j.video.file} quantidade=${q} formato=${fmt} />
        </${Passo}>`
      : null}
  </div>`
}

const ESTADO = { pendente: 'Esperando o computador', gerando: 'O computador está fazendo', pronto: 'Pronto', erro: 'Não deu' }

/**
 * Pedir ao computador: o trabalho completo (takes em 9:16 ou ProRes, TIFF, vídeo pesado), feito pelo app SOBEDESCE
 * do computador da mesma conta. A pasta pronta sobe ao lado do vídeo no Drive.
 */
function NoComputador({ file, quantidade, formato, abertoInicial = false }) {
  const [aberto, setAberto] = useState(abertoInicial)
  const [takes, setTakes] = useState({ quantidade: 6, duracao: 3, formato: '9:16', codec: 'h264' })
  const [pedidos, setPedidos] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let vivo = true
    const ac = new AbortController()
    const ler = () => framesPedidos(file.id, ac.signal).then((p) => vivo && setPedidos(p), () => {})
    ler()
    const t = setInterval(() => document.visibilityState === 'visible' && ler(), 10_000)
    return () => {
      vivo = false
      ac.abort()
      clearInterval(t)
    }
  }, [file.id])
  const ultimo = pedidos?.[0] || null
  const pedir = async () => {
    setBusy(true)
    try {
      const r = await pedirFrames(file, { frames: { quantidade, formato }, takes: { ...takes, audio: true } })
      if (r.pedido) setPedidos((p) => [r.pedido, ...(p || []).filter((x) => x.id !== r.pedido.id)])
      toast(r.novo ? 'Pedido enviado. O computador faz e sobe a pasta ao lado do vídeo.' : 'Esse vídeo já está esperando o computador.', { tone: 'success', ms: 4500 })
      setAberto(false)
    } catch (err) {
      toast(err?.message || 'Não consegui pedir.', { tone: 'error' })
    }
    setBusy(false)
  }
  const seg = (rotulo, campo, opcoes, fmt = (v) => v) => html`<div class="cr-seg"><span class="k-rotulo">${rotulo}</span>
    <${Pilulas} label=${rotulo} valor=${takes[campo]} onEscolher=${(o) => setTakes((t) => ({ ...t, [campo]: o }))} itens=${opcoes.map((o) => ({ value: o, label: fmt(o) }))} />
  </div>`
  return html`<div class="cr-pc">
    ${ultimo
      ? html`<div class=${cx('cr-pc-estado', `is-${ultimo.status}`)}>
          <${Icon} name=${ultimo.status === 'pronto' ? 'circle-check' : ultimo.status === 'erro' ? 'warning' : 'laptop'} size=${18} />
          <span><b>${ESTADO[ultimo.status] || ultimo.status}</b><small>${ultimo.status === 'pronto' ? ultimo.resultado || 'A pasta subiu ao lado do vídeo.' : ultimo.status === 'erro' ? ultimo.erro : 'Frames e takes, numa pasta ao lado do vídeo no Drive.'}</small></span>
          ${ultimo.status === 'erro' ? html`<button type="button" class="link-btn" onClick=${() => tentarDeNovo(ultimo.id).then((p) => p && setPedidos((x) => [p, ...(x || []).slice(1)]), (e) => toast(e.message, { tone: 'error' }))}>Tentar de novo</button>` : null}
        </div>`
      : null}
    ${aberto
      ? html`<div class="cr-pc-form">
          <p class="cr-nota">O app do computador faz em alta, com takes, e sobe a pasta ao lado do vídeo. Precisa estar aberto, com a mesma conta.</p>
          ${seg('Takes', 'quantidade', [3, 6, 10])}
          ${seg('Duração', 'duracao', [2, 3, 5], (v) => `${v} s`)}
          ${seg('Formato', 'formato', ['9:16', '4:5', 'original'], (v) => (v === 'original' ? 'Original' : v))}
          ${seg('Arquivo', 'codec', ['h264', 'prores'], (v) => (v === 'h264' ? 'H.264' : 'ProRes'))}
          <${Button} variant="secondary" size="xl" icon="laptop" loading=${busy} onClick=${pedir}>Pedir ao computador</${Button}>
        </div>`
      : html`<button type="button" class="cr-pc-abrir" onClick=${() => setAberto(true)}>
          <${Icon} name="laptop" size=${18} /><span><b>Completo, no computador</b><small>Com takes em 9:16 ou ProRes. Sobe pro Drive sozinho.</small></span><${Icon} name="chevron-right" size=${16} />
        </button>`}
  </div>`
}

// Onde cada fase fica na barra: com o download antes, ele pega o começo.
const FAIXAS = { baixando: [0, 40], lendo: [40, 80], frames: [80, 100] }
const FAIXAS_STREAM = { lendo: [0, 50], frames: [50, 100] }

function Andamento({ j }) {
  const pct = Math.round((j.frac || 0) * 100)
  const [ini, fim] = (j.baixou ? FAIXAS : FAIXAS_STREAM)[j.fase] || [0, 100]
  const titulo = { baixando: 'Descendo o vídeo…', lendo: 'Assistindo o vídeo…' }[j.fase] || 'Tirando os frames em alta…'
  const sub =
    j.fase === 'baixando'
      ? `${bytes((j.frac || 0) * j.video.size)} de ${bytes(j.video.size)}`
      : j.fase === 'lendo'
        ? 'Escuro, desfocado, tremido, perto de corte e repetido ficam de fora.'
        : `${count(j.frames?.length || 0)} prontos`
  const total = Math.round(ini + ((fim - ini) * pct) / 100)
  return html`<div class="cr-passos" aria-live="polite">
    <${Destaque} titulo=${titulo} numero=${`${total}%`} progresso=${total / 100} vivo=${true} linha=${sub} class="k-entra" />
    <div class="cr-anda-acoes"><${Button} variant="secondary" onClick=${() => j.ac?.abort()}>Parar</${Button}></div>
  </div>`
}

function Resultado({ j }) {
  const [, force] = useState(0)
  const sel = j.frames.filter((f) => f.sel).sort((a, b) => a.sel - b.sel)
  const alternar = (f) => {
    if (f.sel) {
      const n = f.sel
      f.sel = 0
      for (const x of j.frames) if (x.sel > n) x.sel--
    } else f.sel = sel.length + 1
    force((x) => x + 1)
  }
  const nomear = (c) => {
    const nome = prompt(`Nome da cena ${String(c.n).padStart(2, '0')} (vira a pasta no Drive)`, c.nome || '')
    if (nome == null) return
    c.nome = nome.trim().slice(0, 60) || null
    force((x) => x + 1)
  }
  const escolhidos = sel.length ? sel : j.frames
  return html`<div class="cr-res">
    <div class="cr-res-top">
      <span class="k-rotulo">Pronto</span>
      <button type="button" class="link-btn" onClick=${limpar}>Novo</button>
    </div>
    <${Stats}
      itens=${[
        { icone: 'photo', valor: count(j.frames.length), rotulo: 'frames' },
        { icone: 'film', valor: count(j.cenas.length), rotulo: 'cenas', tom: 'up' },
        { icone: 'check', valor: count(sel.length), rotulo: 'escolhidos', tom: 'ok' },
      ]}
    />
    ${j.fonte?.tipo === 'proxy'
      ? html`<p class="cr-aviso"><${Icon} name="info" size=${15} />O iPhone não abre o original, então estes frames vieram do proxy (${j.fonte.largura}×${j.fonte.altura}). Para tirar do original em alta, peça ao computador.</p>`
      : null}
    ${j.cenas.map((c) => {
      const fs = j.frames.filter((f) => f.cena === c.n)
      if (!fs.length) return null
      return html`<section key=${c.n} class="cr-cena">
        <header>
          <span class="cr-cena-n">${String(c.n).padStart(2, '0')}</span>
          <button type="button" class="cr-cena-nome" onClick=${() => nomear(c)}>${c.nome || c.tags.join(' · ')} <${Icon} name="pencil" size=${12} /></button>
        </header>
        <div class="cr-grade">
          ${fs.map(
            (f) => html`<button type="button" key=${f.id} class=${cx('cr-frame', f.sel && 'is-sel')} onClick=${() => alternar(f)} aria-pressed=${f.sel ? 'true' : 'false'} aria-label=${`${f.id} ${tc(f.tc)}`}>
              <img src=${f.miniUrl} alt="" style=${`aspect-ratio:${f.largura}/${f.altura}`} />
              <span class="cr-frame-tc">${tc(f.tc)}</span>
              ${f.sel ? html`<span class="cr-frame-n">${f.sel}</span>` : null}
            </button>`,
          )}
        </div>
      </section>`
    })}
    <div class="cr-acoes">
      <span class="cr-acoes-txt">${sel.length ? `${sel.length} escolhido${sel.length > 1 ? 's' : ''}` : 'Toque para escolher'}</span>
      <div class="cr-acoes-btns">
        <button type="button" class="selact" onClick=${() => salvarNoCelular(escolhidos.map((f) => ({ blob: f.blob, nome: f.nome })))}><${Icon} name="download" size=${20} /><span>Salvar</span></button>
        <button type="button" class="selact" onClick=${() => subir({ frames: escolhidos })}><${Icon} name="upload" size=${20} /><span>Subir</span></button>
        <button type="button" class="selact is-strong" onClick=${() => openSheet('framesPost', { ids: sel.map((f) => f.id) })}><${Icon} name="grid" size=${20} /><span>Post</span></button>
      </div>
    </div>
  </div>`
}

function FramesTela({ onVoltar }) {
  const j = useJob()
  return html`<div class="cr-frames">
    <button type="button" class="cr-voltar" onClick=${onVoltar}><${Icon} name="chevron-left" size=${18} />Criar</button>
    <header class="k-cabeca k-entra" style="--i:0">
      <div class="k-cabeca-txt">
        <h1>Frames</h1>
        <p>Do filme pronto aos posts: frames em alta e artes para as redes.</p>
      </div>
    </header>
    ${!j
      ? html`<${Passo} n=${1} titulo="O vídeo final" frase="O filme pronto, do Drive ou da galeria." i=${1}><${Escolher} /></${Passo}>`
      : j.fase === 'ajustes'
        ? html`<${Ajustes} j=${j} />`
        : j.fase === 'baixando' || j.fase === 'lendo' || j.fase === 'frames'
          ? html`<${Andamento} j=${j} />`
          : j.fase === 'erro'
            ? html`<div class="cr-card cr-erro" role="alert">
                <${Icon} name="warning" size=${24} /><b>${j.erroFormato ? 'O iPhone não abre este arquivo' : 'Não terminei'}</b><p>${j.erro}</p>
                ${j.erroFormato && j.video.origem === 'drive'
                  ? html`<div class="cr-erro-pc"><${NoComputador} file=${j.video.file} quantidade=${12} formato="jpg" abertoInicial=${true} /></div>`
                  : j.erroFormato
                    ? html`<p class="cr-erro-galeria">Suba o vídeo para o Drive (aba Início) e peça os frames ao computador: ele abre qualquer formato.</p>`
                    : null}
                <${Button} variant="secondary" onClick=${() => Object.assign(j, { fase: 'ajustes' }) && mudou()}>Tentar de novo</${Button}>
              </div>`
            : html`<${Resultado} j=${j} />`}
  </div>`
}

// ───── folha do post ─────

const imgs = new Map()
const carregar = (url) => {
  if (!imgs.has(url))
    imgs.set(
      url,
      new Promise((ok, falha) => {
        const i = new Image()
        i.onload = () => ok(i)
        i.onerror = falha
        i.src = url
      }),
    )
  return imgs.get(url)
}

const PREVIA = 0.4 // escala da prévia (o post sai em 2)

export function FramesPostSheet({ ids = [] }) {
  const j = job
  const [p, setP] = useState({ layout: 'triade', n: 3, proporcao: '4:5', fundo: 'preto', titulo: nomeSemExt(j?.video.nome), slides: 2 })
  const [busy, setBusy] = useState(null)
  const [enq, setEnq] = useState({}) // id do frame → { x, y, zoom }: vale em qualquer formato
  const [ativo, setAtivo] = useState(null) // índice do frame sendo enquadrado
  const toque = useRef({ dedos: new Map() })
  const cv = useRef(null)
  const L = layoutPorId(p.layout)
  const n = L.quantos.includes(p.n) ? p.n : L.padrao
  const usados = useMemo(() => {
    if (!j) return []
    const porId = new Map(j.frames.map((f) => [f.id, f]))
    const s = ids.map((id) => porId.get(id)).filter(Boolean)
    const resto = j.frames.filter((f) => !s.includes(f)).sort((a, b) => b.nota - a.nota)
    return s.concat(resto).slice(0, n).sort((a, b) => a.t - b.t)
  }, [ids, n])
  const desenhar = async (alvo, escala, destaque = null) => {
    const imagens = await Promise.all(usados.map((f) => carregar(f.url)))
    const enquadres = usados.map((f) => enq[f.id])
    return desenharPost(alvo, { layout: p.layout, proporcao: p.proporcao, escala, imagens, fundo: p.fundo, textos: { titulo: p.titulo, legendas: p.layout === 'polaroid' ? [p.titulo] : undefined }, timecodes: usados.map((f) => f.tc), slides: p.slides, cheio: cheio, enquadres, destaque })
  }
  const ultimo = p.layout === 'carrossel' ? 0 : usados.length - 1
  const podeCheio = p.layout === 'triade' || p.layout === 'grade'
  const cheio = podeCheio && p.cheio
  const emEdicao = ativo != null && ativo <= ultimo ? ativo : null
  useEffect(() => {
    let vivo = true
    const c = document.createElement('canvas')
    desenhar(c, PREVIA, emEdicao).then(() => {
      if (!vivo || !cv.current) return
      cv.current.width = c.width
      cv.current.height = c.height
      cv.current.getContext('2d').drawImage(c, 0, 0)
    })
    return () => {
      vivo = false
    }
  }, [p, usados, enq, emEdicao])
  if (!j) return null

  // ── enquadrar: tocar escolhe o frame; arrastar move; pinça (ou a barra) aproxima ──
  const ponto = (e) => {
    const r = cv.current.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * cv.current.width) / r.width, y: ((e.clientY - r.top) * cv.current.height) / r.height }
  }
  const noPonto = (pt) => frameNoPonto(p.layout, { proporcao: p.proporcao, escala: PREVIA, n: usados.length, slides: p.slides, cheio }, pt.x, pt.y)
  const distancia = (d) => {
    const [a, b] = [...d.values()]
    return Math.hypot(a.x - b.x, a.y - b.y) || 1
  }
  const mudaEnq = (i, fn) => {
    const f = usados[i]
    if (f) setEnq((x) => ({ ...x, [f.id]: fn(x[f.id], f) }))
  }
  const desce = (e) => {
    const t = toque.current
    const pt = ponto(e)
    t.dedos.set(e.pointerId, pt)
    if (t.dedos.size === 1) {
      t.alvo = noPonto(pt)
      t.andou = 0
      // Já enquadrando: tocar noutro frame passa para ele e já arrasta.
      if (emEdicao != null && t.alvo) {
        if (t.alvo.i !== emEdicao) setAtivo(t.alvo.i)
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }
    } else if (t.dedos.size === 2 && emEdicao != null) {
      t.dist0 = distancia(t.dedos)
      t.zoom0 = enquadreDe(enq[usados[emEdicao]?.id]).zoom
    }
  }
  const move = (e) => {
    const t = toque.current
    const ant = t.dedos.get(e.pointerId)
    if (!ant) return
    const pt = ponto(e)
    t.dedos.set(e.pointerId, pt)
    t.andou += Math.abs(pt.x - ant.x) + Math.abs(pt.y - ant.y)
    if (emEdicao == null || !t.alvo) return
    if (t.dedos.size >= 2) {
      if (t.dist0) mudaEnq(emEdicao, (x) => ({ ...enquadreDe(x), zoom: Math.min(ZOOM_MAX, Math.max(1, (t.zoom0 * distancia(t.dedos)) / t.dist0)) }))
      return
    }
    mudaEnq(t.alvo.i, (x, f) => moverEnquadre(x, pt.x - ant.x, pt.y - ant.y, f.largura, f.altura, t.alvo.caixa))
  }
  const sobe = (e) => {
    const t = toque.current
    if (!t.dedos.delete(e.pointerId)) return
    if (t.dedos.size < 2) t.dist0 = 0
    // Toque sem arrastar: escolhe o frame (fora de todos, sai do enquadramento).
    if (t.dedos.size === 0 && t.andou < 6 && e.type === 'pointerup') setAtivo(t.alvo ? t.alvo.i : null)
  }
  const atual = emEdicao != null ? enquadreDe(enq[usados[emEdicao]?.id]) : null
  const ajustado = (f) => {
    const e = enq[f.id]
    return Boolean(e) && (e.zoom > 1.001 || Math.abs(e.x - 0.5) > 0.001 || Math.abs(e.y - 0.5) > 0.001)
  }
  const gerar = async () => {
    const c = await desenhar(document.createElement('canvas'), 2)
    const partes = p.layout === 'carrossel' ? fatiar(c, p.slides) : [c]
    const base = baseDoNome(j.video.nome)
    const out = []
    for (const [i, x] of partes.entries()) {
      const blob = await new Promise((ok) => x.toBlob(ok, 'image/jpeg', 0.95))
      out.push({ blob, nome: `${base}_Post_${L.nome}${partes.length > 1 ? `_${i + 1}de${partes.length}` : L.quantos.length > 1 ? `_${n}` : ''}_${p.proporcao.replace(':', 'x')}.jpg` })
    }
    return out
  }
  const acao = async (qual) => {
    setBusy(qual)
    try {
      const posts = await gerar()
      if (qual === 'salvar') await salvarNoCelular(posts)
      else {
        closeSheet()
        await subir({ posts })
      }
    } catch (err) {
      toast(err?.message || 'Não consegui montar o post.', { tone: 'error' })
    }
    setBusy(null)
  }
  const muda = (o) => setP((x) => ({ ...x, ...o }))
  return html`<${SheetHead} title="Post" left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Fechar</button>`} />
    <div class="sheet-scroll"><div class="cr-post">
      <div class=${cx('cr-post-tela', p.layout === 'carrossel' && 'is-carrossel', emEdicao != null && 'is-enquadrando')}>
        <canvas ref=${cv} aria-label="Prévia do post. Toque num frame para enquadrar." onPointerDown=${desce} onPointerMove=${move} onPointerUp=${sobe} onPointerCancel=${sobe}></canvas>
      </div>
      ${atual
        ? html`<div class="cr-enq" role="group" aria-label=${`Enquadrar o frame ${emEdicao + 1}`}>
            <div class="cr-enq-top">
              <span><b>Frame ${emEdicao + 1}</b><small>Arraste e use a pinça para aproximar.</small></span>
              <button type="button" class="link-btn" disabled=${!ajustado(usados[emEdicao])} onClick=${() => mudaEnq(emEdicao, () => undefined)}>Centralizar</button>
              <button type="button" class="cr-enq-ok" onClick=${() => setAtivo(null)}>Pronto</button>
            </div>
            <label class="cr-enq-zoom"><${Icon} name="zoom" size=${16} />
              <input type="range" aria-label="Zoom" min="1" max=${ZOOM_MAX} step="0.01" value=${atual.zoom} onInput=${(e) => mudaEnq(emEdicao, (x) => ({ ...enquadreDe(x), zoom: Number(e.currentTarget.value) }))} />
              <output>${atual.zoom.toFixed(1).replace('.', ',')}×</output>
            </label>
          </div>`
        : html`<p class="cr-dica-enq"><${Icon} name="crop" size=${14} />Toque num frame para mudar o enquadramento.</p>`}
      <div class="cr-layouts" role="radiogroup" aria-label="Formato">
        ${LAYOUTS.map((l) => html`<button type="button" role="radio" aria-checked=${p.layout === l.id ? 'true' : 'false'} class=${cx('cr-chip', p.layout === l.id && 'is-on')} onClick=${() => muda({ layout: l.id, n: l.padrao })}>${l.nome}</button>`)}
      </div>
      ${L.quantos.length > 1
        ? html`<div class="cr-linha"><span>Frames</span><div class="segmented">${L.quantos.map((q) => html`<button type="button" class=${cx('segmented-opt', n === q && 'is-on')} onClick=${() => muda({ n: q })}>${L.id === 'grade' ? (q === 4 ? '2×2' : '3×3') : q}</button>`)}</div></div>`
        : null}
      ${L.slides ? html`<div class="cr-linha"><span>Slides</span><div class="segmented">${L.slides.map((q) => html`<button type="button" class=${cx('segmented-opt', p.slides === q && 'is-on')} onClick=${() => muda({ slides: q })}>${q}</button>`)}</div></div>` : null}
      <div class="cr-linha"><span>Tamanho</span><div class="segmented">${['4:5', '1:1', '9:16'].map((q) => html`<button type="button" class=${cx('segmented-opt', p.proporcao === q && 'is-on')} onClick=${() => muda({ proporcao: q })}>${q}</button>`)}</div></div>
      ${podeCheio
        ? html`<div class="cr-linha is-switch"><span>Tela cheia<small>sem bordas do fundo</small></span><button type="button" class="cr-switch" role="switch" aria-checked=${p.cheio ? 'true' : 'false'} aria-label="Tela cheia, sem bordas" onClick=${() => muda({ cheio: !p.cheio })}><span class=${cx('switch', p.cheio && 'is-on')} aria-hidden="true"><span></span></span></button></div>`
        : null}
      <div class="cr-linha"><span>Fundo</span><div class="segmented">${Object.keys(FUNDOS).map((q) => html`<button type="button" class=${cx('segmented-opt', p.fundo === q && 'is-on')} onClick=${() => muda({ fundo: q })}>${q[0].toUpperCase() + q.slice(1)}</button>`)}</div></div>
      ${['triade', 'box', 'cinema', 'contato', 'polaroid'].includes(p.layout) && !(p.layout === 'triade' && cheio) ? html`<label class="cr-campo"><span>${p.layout === 'polaroid' ? 'Legenda' : 'Título'}</span><input class="input" value=${p.titulo} maxlength="60" onInput=${(e) => muda({ titulo: e.currentTarget.value })} /></label>` : null}
      <p class="cr-nota">${ids.length ? `Com os ${ids.length} frames que você escolheu.` : 'Escolha automática: os melhores de cada cena.'} JPEG em alta (2160 px).</p>
      <div class="cr-post-btns">
        <${Button} variant="secondary" size="xl" icon="download" loading=${busy === 'salvar'} onClick=${() => acao('salvar')}>Salvar no celular</${Button}>
        <${Button} variant="primary" size="xl" icon="upload" loading=${busy === 'subir'} onClick=${() => acao('subir')}>Subir pro Drive</${Button}>
      </div>
    </div></div>`
}
FramesPostSheet.label = 'Post'
FramesPostSheet.tall = true

// ───── aba ─────

export function CriarScreen({ active, Calculadora = null }) {
  const tela = useApp((s) => s.criarTela || 'hub')
  const ir = (t) => {
    setState({ criarTela: t })
    window.scrollTo(0, 0)
  }
  useJob()
  return html`<div class="screen cr-screen">
    <${TopoMarca} />
    <main class="cr-body">
      ${tela === 'hub'
        ? html`<header class="k-cabeca k-entra" style="--i:0">
            <div class="k-cabeca-txt">
              <h1>Criar</h1>
              <p>Ferramentas para o filme pronto e para a gravação.</p>
            </div>
          </header>`
        : null}
      ${tela === 'frames'
        ? html`<${FramesTela} onVoltar=${() => ir('hub')} />`
        : tela === 'calc' && Calculadora
          ? html`<div class="cr-frames"><button type="button" class="cr-voltar" onClick=${() => ir('hub')}><${Icon} name="chevron-left" size=${18} />Criar</button><${Calculadora} /></div>`
          : html`<${Hub} onFrames=${() => ir('frames')} onCalc=${() => ir('calc')} temCalc=${Boolean(Calculadora)} />
            ${job && job.fase !== 'ajustes' ? html`<button type="button" class="cr-voltar-job" onClick=${() => ir('frames')}>${job.fase === 'pronto' ? `${count(job.frames.length)} frames de “${nomeSemExt(job.video.nome)}” prontos` : 'Fazendo os frames…'} <${Icon} name="chevron-right" size=${16} /></button>` : null}`}
    </main>
  </div>`
}
