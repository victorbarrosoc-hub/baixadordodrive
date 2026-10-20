// Cópia de um arquivo para um ou mais destinos (docs/DISCOS.md), do jeito que a gente quer num cartão de câmera:
//   - lê a origem UMA vez, em blocos de 8 MB, e grava o mesmo bloco em todos os destinos ao mesmo tempo;
//   - enquanto grava um bloco, já lê o próximo (dois buffers alternados);
//   - calcula o checksum no caminho (xxHash64, ~4 GB/s, o padrão das ferramentas de offload de cinema; ou MD5, o mesmo
//     do Google Drive, ~0,6 GB/s); grava em "<nome>.sobedesce-parcial", sincroniza com o disco e só então dá o nome final
//     (um cabo que sai no meio não deixa arquivo pela metade com cara de pronto);
//   - mantém a data de modificação;
//   - conferir: lê cada destino de novo e compara o checksum com o da origem.
// Roda dentro de um worker (worker.js), para o checksum não travar o app.
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import xxhash from 'xxhash-wasm'

export const BLOCO = 8 * 1024 * 1024
const FILA = 4 // blocos no anel: 3 leituras adiantadas + o que está gravando (medido: ~3,5x mais rápido que 1 adiantada)
export const PARCIAL = '.sobedesce-parcial'

export const ALGORITMOS = ['xxh64', 'md5']

let xx = null
/** Um checksum em andamento: update(bytes) e hex(). */
export async function criarHash(algoritmo = 'xxh64') {
  if (algoritmo === 'md5') {
    const h = crypto.createHash('md5')
    return { update: (b) => h.update(b), hex: () => h.digest('hex') }
  }
  xx ??= xxhash()
  const h = (await xx).create64()
  return { update: (b) => h.update(b), hex: () => h.digest().toString(16).padStart(16, '0') }
}

/** Buffer do tamanho do arquivo (+1 para ver o fim), até 8 MB: vários arquivos pequenos ao mesmo tempo não gastam memória à toa. */
export const blocoPara = (tamanho) => (Number.isFinite(tamanho) ? Math.min(BLOCO, Math.max(64 * 1024, tamanho + 1)) : BLOCO)

export class CopiaCancelada extends Error {
  constructor() {
    super('Cópia cancelada.')
    this.name = 'CopiaCancelada'
  }
}

async function gravarTudo(fh, buf) {
  let feito = 0
  while (feito < buf.length) {
    const { bytesWritten } = await fh.write(buf, feito, buf.length - feito)
    feito += bytesWritten
  }
}

/** Checksum de um arquivo (para conferir o destino). `onBytes(n)` a cada bloco; `parar()` true interrompe. */
export async function hashDoArquivo(arquivo, { algoritmo = 'xxh64', tamanho, onBytes, parar } = {}) {
  const hash = await criarHash(algoritmo)
  const fh = await fsp.open(arquivo, 'r')
  const buf = Buffer.allocUnsafe(blocoPara(tamanho))
  try {
    for (;;) {
      if (parar?.()) throw new CopiaCancelada()
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (!bytesRead) break
      hash.update(buf.subarray(0, bytesRead))
      onBytes?.(bytesRead)
    }
  } finally {
    await fh.close().catch(() => {})
  }
  return hash.hex()
}

/**
 * @param {{ origem: string, destinos: string[], tamanho?: number, mtimeMs?: number, conferir?: boolean, algoritmo?: 'xxh64'|'md5',
 *           onBytes?: (n: number, fase: 'copiando'|'conferindo') => void, parar?: () => boolean }} o
 * @returns {Promise<{ hash: string, algoritmo: string, bytes: number, destinos: Array<{ caminho: string, ok: boolean, hash?: string, erro?: string }> }>}
 */
export async function copiarArquivo({ origem, destinos, tamanho, mtimeMs, conferir = true, algoritmo = 'xxh64', onBytes, parar }) {
  const hash = await criarHash(algoritmo)
  const entrada = await fsp.open(origem, 'r')
  const saidas = []
  const parciais = destinos.map((d) => d + PARCIAL)
  let total = 0
  let leitura = null
  try {
    for (let i = 0; i < destinos.length; i++) {
      await fsp.mkdir(path.dirname(destinos[i]), { recursive: true })
      saidas.push(await fsp.open(parciais[i], 'w'))
    }
    // Anel de buffers: leituras adiantadas (até FILA) enquanto um bloco vai para os destinos. Arquivo pequeno: um buffer
    // do tamanho dele. Lê até o tamanho conhecido +1 byte; se o arquivo cresceu no meio, segue lendo até o fim.
    const bl = blocoPara(tamanho)
    const n = bl < BLOCO ? 1 : FILA
    const bufs = Array.from({ length: n }, () => Buffer.allocUnsafe(bl))
    const pedidos = []
    let feitos = 0
    let posLida = 0
    let limite = Number.isFinite(tamanho) ? tamanho + 1 : Infinity
    // `max`: quantas leituras podem ficar pedidas. Antes de gravar um bloco, n-1 (o buffer dele está em uso).
    const adiantar = (max) => {
      while (pedidos.length < max && posLida < limite) {
        const buf = bufs[(feitos + pedidos.length) % n]
        pedidos.push(entrada.read(buf, 0, bl, posLida).then((r) => ({ buf, bytesRead: r.bytesRead })))
        posLida += bl
      }
    }
    leitura = { catch: () => Promise.all(pedidos.map((p) => p.catch(() => {}))) }
    adiantar(n)
    for (;;) {
      if (parar?.()) throw new CopiaCancelada()
      if (!pedidos.length) {
        limite = Infinity // passou do tamanho conhecido sem achar o fim: o arquivo cresceu
        adiantar(n)
      }
      const { buf, bytesRead } = await pedidos.shift()
      feitos++
      if (!bytesRead) {
        await Promise.all(pedidos.splice(0).map((p) => p.catch(() => {})))
        break
      }
      adiantar(n - 1)
      const parte = buf.subarray(0, bytesRead)
      const gravando = Promise.all(saidas.map((s) => gravarTudo(s, parte)))
      hash.update(parte) // o checksum roda enquanto o disco grava
      await gravando
      total += bytesRead
      onBytes?.(bytesRead, 'copiando')
    }
    await Promise.all(saidas.map((s) => s.sync()))
    await Promise.all(saidas.map((s) => s.close()))
    saidas.length = 0
    for (let i = 0; i < destinos.length; i++) {
      await fsp.rename(parciais[i], destinos[i])
      if (Number.isFinite(mtimeMs)) await fsp.utimes(destinos[i], new Date(), new Date(mtimeMs)).catch(() => {})
    }
  } catch (err) {
    leitura?.catch(() => {}) // o bloco que já vinha do disco não importa mais
    await Promise.all(saidas.map((s) => s.close().catch(() => {})))
    await Promise.all(parciais.map((p) => fsp.rm(p, { force: true }).catch(() => {})))
    throw err
  } finally {
    await entrada.close().catch(() => {})
  }
  const original = hash.hex()
  // Conferência: cada destino é lido de novo (discos diferentes, ao mesmo tempo).
  const resultado = await Promise.all(
    destinos.map(async (caminho) => {
      if (!conferir) return { caminho, ok: true }
      try {
        const h = await hashDoArquivo(caminho, { algoritmo, tamanho: total, onBytes: (n) => onBytes?.(n / destinos.length, 'conferindo'), parar })
        return h === original ? { caminho, ok: true, hash: h } : { caminho, ok: false, hash: h, erro: 'O conteúdo gravado não bate com a origem.' }
      } catch (err) {
        if (err instanceof CopiaCancelada) throw err
        return { caminho, ok: false, erro: `Não consegui ler de volta (${err.code || err.message}).` }
      }
    }),
  )
  return { hash: original, algoritmo, bytes: total, destinos: resultado }
}

/**
 * Confere um arquivo que já estava no destino (mesmo tamanho): lê a origem e os destinos ao mesmo tempo e compara os
 * checksums. `ok` false = o conteúdo é outro (copiar de novo).
 */
export async function compararArquivos({ origem, destinos, tamanho, algoritmo = 'xxh64', onBytes, parar }) {
  const partes = destinos.length + 1
  const ler = (c, origemMesmo) =>
    hashDoArquivo(c, { algoritmo, tamanho, parar, onBytes: (n) => onBytes?.(n / partes, 'conferindo') }).catch((err) => {
      if (err instanceof CopiaCancelada || origemMesmo) throw err
      return null
    })
  const [h0, ...hs] = await Promise.all([ler(origem, true), ...destinos.map((d) => ler(d, false))])
  return { hash: h0, algoritmo, destinos: destinos.map((caminho, i) => ({ caminho, ok: hs[i] === h0 })) }
}
