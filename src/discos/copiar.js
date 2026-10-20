// Cópia de um arquivo para um ou mais destinos (docs/DISCOS.md), do jeito que a gente quer num cartão de câmera:
//   - lê a origem UMA vez, em blocos de 8 MB, e grava o mesmo bloco em todos os destinos ao mesmo tempo;
//   - enquanto grava um bloco, já lê o próximo (dois buffers alternados);
//   - calcula o MD5 no caminho; grava em "<nome>.sobedesce-parcial", sincroniza com o disco e só então dá o nome final
//     (um cabo que sai no meio não deixa arquivo pela metade com cara de pronto);
//   - mantém a data de modificação;
//   - conferir: lê cada destino de novo e compara o MD5 com o da origem.
// Roda dentro de um worker (worker.js), para o MD5 não travar o app.
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const BLOCO = 8 * 1024 * 1024
export const PARCIAL = '.sobedesce-parcial'

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

/** MD5 de um arquivo (para conferir o destino). `onBytes(n)` a cada bloco; `parar()` true interrompe. */
export async function md5DoArquivo(arquivo, { onBytes, parar } = {}) {
  const fh = await fsp.open(arquivo, 'r')
  const hash = crypto.createHash('md5')
  const buf = Buffer.allocUnsafe(BLOCO)
  try {
    for (;;) {
      if (parar?.()) throw new CopiaCancelada()
      const { bytesRead } = await fh.read(buf, 0, BLOCO, null)
      if (!bytesRead) break
      hash.update(buf.subarray(0, bytesRead))
      onBytes?.(bytesRead)
    }
  } finally {
    await fh.close().catch(() => {})
  }
  return hash.digest('hex')
}

/**
 * @param {{ origem: string, destinos: string[], mtimeMs?: number, conferir?: boolean,
 *           onBytes?: (n: number, fase: 'copiando'|'conferindo') => void, parar?: () => boolean }} o
 * @returns {Promise<{ md5: string, bytes: number, destinos: Array<{ caminho: string, ok: boolean, md5?: string, erro?: string }> }>}
 */
export async function copiarArquivo({ origem, destinos, mtimeMs, conferir = true, onBytes, parar }) {
  const entrada = await fsp.open(origem, 'r')
  const saidas = []
  const parciais = destinos.map((d) => d + PARCIAL)
  const hash = crypto.createHash('md5')
  let total = 0
  let leitura = null
  try {
    for (let i = 0; i < destinos.length; i++) {
      await fsp.mkdir(path.dirname(destinos[i]), { recursive: true })
      saidas.push(await fsp.open(parciais[i], 'w'))
    }
    const bufs = [Buffer.allocUnsafe(BLOCO), Buffer.allocUnsafe(BLOCO)]
    let qual = 0
    let pos = 0
    const ler = (b, p) => entrada.read(bufs[b], 0, BLOCO, p)
    leitura = ler(qual, pos)
    for (;;) {
      if (parar?.()) throw new CopiaCancelada()
      const { bytesRead } = await leitura
      if (!bytesRead) break
      const parte = bufs[qual].subarray(0, bytesRead)
      pos += bytesRead
      qual ^= 1
      leitura = ler(qual, pos) // o próximo bloco vem do disco enquanto este vai para os destinos
      hash.update(parte)
      await Promise.all(saidas.map((s) => gravarTudo(s, parte)))
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
  const md5 = hash.digest('hex')
  // Conferência: cada destino é lido de novo (discos diferentes, ao mesmo tempo).
  const resultado = await Promise.all(
    destinos.map(async (caminho) => {
      if (!conferir) return { caminho, ok: true }
      try {
        const m = await md5DoArquivo(caminho, { onBytes: (n) => onBytes?.(n / destinos.length, 'conferindo'), parar })
        return m === md5 ? { caminho, ok: true, md5: m } : { caminho, ok: false, md5: m, erro: 'O conteúdo gravado não bate com a origem.' }
      } catch (err) {
        if (err instanceof CopiaCancelada) throw err
        return { caminho, ok: false, erro: `Não consegui ler de volta (${err.code || err.message}).` }
      }
    }),
  )
  return { md5, bytes: total, destinos: resultado }
}
