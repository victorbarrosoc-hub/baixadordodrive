// PSD/PSB no celular (lib/psd-ler.js faz a leitura): miniatura sem depender do Google (o Drive não gera para muitos
// PSDs), a imagem final em alta e as pranchetas. Só busca do Drive os pedaços que precisa (Range):
//   miniatura  → os primeiros 64 KB (às vezes um pedaço a mais, quando os recursos são grandes);
//   camadas    → até 3 MB a partir da seção de camadas (os nomes e as pranchetas vêm antes dos pixels);
//   imagem     → da imagem final até o fim do arquivo (sem as camadas), decodificada no lib/psd-worker.js.
import { LAN } from './config.js'
import { driveCall } from './drive.js'
import { MAX_CAMADAS, MAX_COMPOSTA, ehPsd, lerCabecalho, lerCamadas, miniaturaDosRecursos } from './psd-ler.js'

export { ehPsd }
export const MAX_RECURSOS = 8e6
/** Imagem final até isso abre sozinha; maior, pede um toque (é o que vai baixar). */
export const AUTO_COMPOSTA = 30e6

const idDe = (f) => f.shortcutDetails?.targetId || f.id
const chaveDe = (f) => `${idDe(f)}:${f.modifiedTime || ''}`
export const podePsd = (f) => !LAN && ehPsd(f)

/** Bytes [a, b) do arquivo no Drive. `onProgress(0..1)`. Se o Drive ignorar o Range, pula até `a` e para em `b`. */
export async function faixa(id, a, b, { signal, onProgress } = {}) {
  const res = await driveCall(`/files/${encodeURIComponent(id)}`, {
    query: { alt: 'media', supportsAllDrives: true },
    headers: { Range: `bytes=${a}-${b - 1}` },
    raw: true,
    signal,
    retries: 2,
  })
  const quer = b - a
  const out = new Uint8Array(quer)
  let pular = res.status === 206 ? 0 : a
  let got = 0
  const reader = res.body.getReader()
  try {
    while (got < quer) {
      const { done, value } = await reader.read()
      if (done) break
      let v = value
      if (pular) {
        if (v.length <= pular) {
          pular -= v.length
          continue
        }
        v = v.subarray(pular)
        pular = 0
      }
      const k = Math.min(v.length, quer - got)
      out.set(v.subarray(0, k), got)
      got += k
      onProgress?.(got / quer)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return got < quer ? out.slice(0, got) : out
}

// ───── cabeçalho e miniatura ─────

const infos = new Map() // chave → Promise<{ cab, mini }>
const prontas = new Map() // chave → url da miniatura | null (para desenhar sem esperar)
let rodando = 0
const fila = []
const vez = () =>
  new Promise((resolve) => {
    if (rodando < 3) {
      rodando++
      resolve()
    } else fila.push(resolve)
  })
const soltar = () => {
  const prox = fila.shift()
  if (prox) prox()
  else rodando--
}

async function lerInfo(f) {
  const id = idDe(f)
  const tamanho = Number(f.size) || Infinity
  let head = await faixa(id, 0, Math.min(tamanho, 65536))
  let cab = lerCabecalho(head)
  if (cab.recursosLen == null) {
    head = await faixa(id, 0, Math.min(tamanho, cab.recursosEm + 4 + 65536))
    cab = lerCabecalho(head)
  }
  let recursos = null
  if (cab.recursosLen != null) {
    const ini = cab.recursosEm + 4
    if (cab.camadasEm <= head.length) recursos = head.subarray(ini, cab.camadasEm)
    else if (cab.recursosLen <= MAX_RECURSOS) recursos = await faixa(id, ini, cab.camadasEm)
  }
  const jpeg = recursos ? miniaturaDosRecursos(recursos) : null
  const mini = jpeg ? URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })) : null
  return { cab, mini, tamanho }
}

/** Cabeçalho e miniatura (guardados enquanto a página está aberta). */
export function infoPsd(f) {
  const k = chaveDe(f)
  let p = infos.get(k)
  if (!p) {
    p = vez().then(() => lerInfo(f).finally(soltar))
    p.then(
      (i) => prontas.set(k, i.mini),
      () => {
        prontas.set(k, null)
        infos.delete(k)
      },
    )
    infos.set(k, p)
    if (infos.size > 300) {
      const velha = infos.keys().next().value
      infos.delete(velha)
      prontas.delete(velha)
    }
  }
  return p
}

/** Miniatura do PSD (url) ou null. */
export function miniaturaPsd(f) {
  return infoPsd(f).then(
    (i) => i.mini,
    () => null,
  )
}

/** Já se sabe? (url, null = não tem) — undefined = ainda não. */
export const miniaturaPsdAgora = (f) => prontas.get(chaveDe(f))

// ───── camadas e imagem final ─────

const camadasCache = new Map() // chave → Promise

/** Camadas e pranchetas (e onde fica a imagem final). */
export function camadasPsd(f) {
  const k = chaveDe(f)
  if (!camadasCache.has(k)) {
    const p = infoPsd(f).then(async ({ cab, tamanho }) => {
      if (cab.camadasEm == null) throw new Error('sem_camadas')
      // 256 KB dão conta de quase todos; se os registros não couberem, lê até 3 MB.
      const id = idDe(f)
      const opts = { psb: cab.psb, camadasEm: cab.camadasEm }
      const primeiro = Math.min(tamanho, cab.camadasEm + 262144)
      const r = lerCamadas(await faixa(id, cab.camadasEm, primeiro), opts)
      const ate = Math.min(tamanho, cab.camadasEm + MAX_CAMADAS)
      if (!r.parcial || ate <= primeiro) return r
      return lerCamadas(await faixa(id, cab.camadasEm, ate), opts)
    })
    p.catch(() => camadasCache.delete(k))
    camadasCache.set(k, p)
    if (camadasCache.size > 50) camadasCache.delete(camadasCache.keys().next().value)
  }
  return camadasCache.get(k)
}

/** Quanto baixa para abrir a imagem final (bytes) ou null se não se sabe. */
export async function tamanhoDaImagem(f) {
  const [{ tamanho }, cam] = await Promise.all([infoPsd(f), camadasPsd(f)])
  return Number.isFinite(tamanho) ? Math.max(0, tamanho - cam.compostaEm) : null
}

let worker = null
let noWorker = null // chave do PSD carregado no worker
let seq = 0
const esperando = new Map()

function falar(msg, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./psd-worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const r = esperando.get(e.data.n)
      if (!r) return
      esperando.delete(e.data.n)
      if (e.data.erro) r.reject(new Error(e.data.erro))
      else r.resolve(e.data)
    }
    worker.onerror = () => {
      for (const r of esperando.values()) r.reject(new Error('worker'))
      esperando.clear()
      worker = null
      noWorker = null
    }
  }
  const n = ++seq
  return new Promise((resolve, reject) => {
    esperando.set(n, { resolve, reject })
    worker.postMessage({ ...msg, n }, transfer)
  })
}

async function paraUrl(img) {
  const canvas = document.createElement('canvas')
  canvas.width = img.largura
  canvas.height = img.altura
  canvas.getContext('2d').putImageData(new ImageData(img.rgba, img.largura, img.altura), 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, img.alfa ? 'image/png' : 'image/jpeg', 0.9))
  canvas.width = canvas.height = 0
  if (!blob) throw new Error('canvas')
  return URL.createObjectURL(blob)
}

/** Carrega a imagem final no worker (baixa da seção dela até o fim do arquivo). */
export async function carregarImagem(f, { signal, onProgress } = {}) {
  const k = chaveDe(f)
  if (noWorker === k) return
  const [{ cab, tamanho }, cam] = await Promise.all([infoPsd(f), camadasPsd(f)])
  const fim = Number.isFinite(tamanho) ? tamanho : cam.compostaEm + MAX_COMPOSTA
  if (fim - cam.compostaEm > MAX_COMPOSTA) throw Object.assign(new Error('grande'), { codigo: 'grande' })
  const bytes = await faixa(idDe(f), cam.compostaEm, fim, { signal, onProgress })
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer
  noWorker = null
  await falar({ tipo: 'carregar', id: k, buf, cab }, [buf])
  noWorker = k
}

/** Desenha (já carregada) a imagem inteira ou um recorte. Devolve uma url (JPEG/PNG). */
export async function desenharPsd(f, { rect = null, max = 2560 } = {}) {
  const r = await falar({ tipo: 'desenhar', id: chaveDe(f), rect, max })
  return paraUrl(r.img)
}

/** Ordem de leitura das pranchetas: de cima para baixo, da esquerda para a direita. */
export function ordenarPranchetas(lista) {
  return lista.slice().sort((a, b) => (Math.abs(a.rect.top - b.rect.top) > 20 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left))
}
