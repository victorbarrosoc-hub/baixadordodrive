// Referência que toca no iPhone. O Instagram manda muitos reels em VP9 dentro de MP4 (às vezes AV1): abre no
// computador, mas o Safari do iPhone não toca, e a prévia do celular mostrava "Este formato não toca no navegador".
//
//  - Antes de subir: se o vídeo baixado veio em VP9/AV1/VP8, vira H.264 + AAC em MP4 (mesmo tamanho de imagem até
//    1920 px no lado maior, ~2,5 Mbit/s, início rápido). Sem ffmpeg com H.264 neste computador, sobe como veio.
//  - As que já estão no Drive: uma passada só, em segundo plano (ConsertoCelular), baixa cada vídeo de referência sem a
//    marca, olha o codec e, se precisar, troca o conteúdo do mesmo arquivo (o mesmo id, link, nome, descrição e
//    coleção; o Drive guarda a versão anterior por 30 dias). Toda referência conferida ganha appProperties.celular = 'ok'
//    e não é olhada de novo, neste ou em outro computador.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { probe, tocaNoIphone, transcodificar } from '../media/previa.js'
import { abortError, isAbortError } from '../util/backoff.js'
import { MARCA } from './metadados.js'

export const MARCA_CELULAR = 'celular'
export const CELULAR_OK = 'ok'
/** Lado maior da conversão: o mesmo limite do download (1080p, vertical até 1920). */
export const LADO_CELULAR = 1920
/** Na passada das antigas, vídeo maior que isso fica como está (só referências curtas são convertidas). */
export const MAX_BYTES_CONSERTO = 400 * 1024 * 1024

/**
 * Deixa `file` tocável no iPhone. Devolve { estado: 'ok' } (já toca), { estado: 'convertido', path, codec, limpar() }
 * (a cópia H.264 numa pasta temporária) ou { estado: 'sem_conversor' | 'nao_abriu' }. Lança PreviaError ou AbortError.
 */
export async function paraCelular(file, { motor, signal, onProgress, tmpRoot = os.tmpdir(), log = () => {} } = {}) {
  if (signal?.aborted) throw abortError(signal)
  if (motor?.via !== 'ffmpeg') return { estado: 'sem_conversor' }
  const info = await probe(motor, file, { signal })
  if (!info) return { estado: 'nao_abriu' }
  if (tocaNoIphone(info)) return { estado: 'ok' }
  const dir = await fs.mkdtemp(path.join(tmpRoot, 'sobedesce-celular-'))
  const limpar = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  const output = path.join(dir, 'video.mp4')
  try {
    await transcodificar(motor, { input: file, output, info, signal, onProgress, lado: LADO_CELULAR, log })
    const st = await fs.stat(output).catch(() => null)
    if (!st || st.size < 1024) throw new Error('a conversão saiu vazia')
    return { estado: 'convertido', path: output, codec: info.video.codec, limpar }
  } catch (err) {
    await limpar()
    throw err
  }
}

/** Referência de vídeo do app ainda sem a marca do celular? (só o que a SOBEDESCE salvou; nada do resto do Drive) */
export function precisaConferir(item) {
  const props = item?.appProperties || {}
  return (
    !item?.isFolder &&
    props.sobedesce === MARCA &&
    props[MARCA_CELULAR] !== CELULAR_OK &&
    /^video\//.test(item.mimeType || '') &&
    Number(item.size) > 0 &&
    Number(item.size) <= MAX_BYTES_CONSERTO
  )
}

const MINUTO = 60_000

/**
 * Passada única pelas referências já salvas (todas as coleções da conta). Roda em segundo plano, um vídeo por vez,
 * só com a conta conectada e um conversor; termina gravando `referenciasCelular` nos ajustes. Falhou um arquivo? Fica
 * para a próxima abertura do app (sem a marca, ele volta a ser conferido).
 */
export class ConsertoCelular {
  /**
   * @param {{ service: object, settings: object, manager: object, motor: () => Promise<object>, converter?: typeof paraCelular,
   *   substituir: (drive, item, localPath, signal) => Promise<void>, marcar: (drive, fileId, signal) => Promise<void>,
   *   esperaMs?: number, log?: Function }} o
   */
  constructor({ service, settings, manager, motor, converter = paraCelular, substituir, marcar, esperaMs = 2 * MINUTO, log = () => {} }) {
    Object.assign(this, { service, settings, manager, motor, converter, substituir, marcar, esperaMs, log })
    this.timer = null
    this.rodando = null
    this.ac = null
    this.feito = false
  }

  ja() {
    try {
      return this.settings?.get?.().referenciasCelular === true
    } catch {
      return false
    }
  }

  /** Marca para daqui a pouco (a abertura do app e a conta entrando chamam isto). */
  agendar(ms = this.esperaMs) {
    if (this.feito || this.rodando || this.timer || this.ja()) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.rodar().catch(() => {})
    }, ms)
    this.timer.unref?.()
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = null
    this.ac?.abort()
  }

  /** @returns {Promise<{ conferidos: number, convertidos: number, falhas: number } | null>} null = não deu para rodar agora */
  rodar() {
    this.rodando ??= this.#rodar().finally(() => {
      this.rodando = null
      this.ac = null
    })
    return this.rodando
  }

  async #rodar() {
    if (this.ja()) return null
    const motor = await this.motor().catch(() => null)
    if (motor?.via !== 'ffmpeg') {
      this.log('referências no celular: sem ffmpeg com H.264 neste computador; as antigas ficam como estão.')
      return null
    }
    this.ac = new AbortController()
    const signal = this.ac.signal
    const conta = { conferidos: 0, convertidos: 0, falhas: 0 }
    let colecoes
    try {
      colecoes = (await this.service.listarColecoes({ forcar: true })).colecoes || []
    } catch {
      return null // sem conta ou sem internet: tenta na próxima abertura
    }
    for (const c of colecoes) {
      let lista
      try {
        lista = await this.service.itens(c.id, { forcar: true, signal })
      } catch (err) {
        if (isAbortError(err)) return null
        conta.falhas++
        continue
      }
      const drive = this.manager.driveFor(lista.accountId)
      for (const item of lista.itens) {
        if (signal.aborted) return null
        if (!precisaConferir(item)) continue
        try {
          if (await this.#um(drive, item, motor, signal)) conta.convertidos++
          conta.conferidos++
        } catch (err) {
          if (isAbortError(err) || signal.aborted) return null
          conta.falhas++
          this.log(`referência no celular: não deu para converter (${err?.message || err})`)
        }
      }
    }
    if (conta.convertidos) this.log(`referências no celular: ${conta.convertidos} vídeo(s) convertido(s) para H.264.`)
    if (!conta.falhas) {
      this.feito = true
      await Promise.resolve(this.settings?.update?.({ referenciasCelular: true })).catch(() => {})
    }
    if (conta.convertidos) this.service.recarregar?.()
    return conta
  }

  async #um(drive, item, motor, signal) {
    const original = await this.manager.previas.baixarOriginal(drive, item, { signal })
    try {
      const r = await this.converter(original.path, { motor, signal, log: this.log })
      if (r.estado === 'convertido') {
        try {
          await this.substituir(drive, item, r.path, signal)
        } finally {
          await r.limpar()
        }
        return true
      }
      if (r.estado === 'ok') await this.marcar(drive, item.id, signal)
      return false
    } finally {
      await original.limpar()
    }
  }
}
