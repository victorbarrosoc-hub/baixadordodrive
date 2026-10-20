// Busca por cena: os arquivos do modelo (≈ 228 MB) baixam uma vez, no primeiro uso, para <dados>/cenas/modelo/.
// Versões fixas (commit do Hugging Face) e SHA-256 conferido: arquivo que não bate é apagado e baixa de novo.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { downloadTo } from '../updater.js'

const ST = 'https://huggingface.co/sentence-transformers/clip-ViT-B-32-multilingual-v1/resolve/58edf8cada9e398793dca955574a48cbb7f18be2'
const XV = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a'

/** nome no disco → { url, tamanho, sha256 } */
export const ARQUIVOS = {
  texto: { nome: 'texto.onnx', url: `${ST}/onnx/model_qint8_arm64.onnx`, tamanho: 135336307, sha256: '3bed77e83926519660b5c0833cb3321cfde952331edec4f7d501c7d384b8a8a7' },
  dense: { nome: 'dense.safetensors', url: `${ST}/2_Dense/model.safetensors`, tamanho: 1572984, sha256: 'd12568dc7300970a4d3dbb49068ad16cd89b99840b74b026f8e48071e9414f74' },
  tokenizador: { nome: 'tokenizer.json', url: `${ST}/tokenizer.json`, tamanho: 1961847, sha256: '5b4e1a8171c81dfd666ae40265b9530c6e0b3d53923fe8ac493dcc84229adf81' },
  visao: { nome: 'visao.onnx', url: `${XV}/onnx/vision_model_quantized.onnx`, tamanho: 89117001, sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299' },
}
export const TOTAL = Object.values(ARQUIVOS).reduce((s, a) => s + a.tamanho, 0)

export class ArquivosModelo {
  /**
   * @param {object} o
   * @param {string} o.dir pasta do modelo
   * @param {object} [o.arquivos] trocável nos testes (mesmo formato de ARQUIVOS)
   * @param {Function} [o.fetch] trocável nos testes
   */
  constructor({ dir, arquivos = ARQUIVOS, fetch } = {}) {
    this.dir = dir
    this.arquivos = arquivos
    this.fetch = fetch
    this.baixando = null
    this.progresso = null // { recebido, total }
    this.erro = null
  }

  caminhos() {
    return Object.fromEntries(Object.entries(this.arquivos).map(([k, a]) => [k, path.join(this.dir, a.nome)]))
  }

  get total() {
    return Object.values(this.arquivos).reduce((s, a) => s + a.tamanho, 0)
  }

  /** Todos no disco com o tamanho certo (o SHA-256 é conferido ao baixar; aqui, só o tamanho, que é rápido). */
  async prontos() {
    for (const a of Object.values(this.arquivos)) {
      const st = await fsp.stat(path.join(this.dir, a.nome)).catch(() => null)
      if (!st || st.size !== a.tamanho) return false
    }
    return true
  }

  status() {
    return { baixando: Boolean(this.baixando), progresso: this.progresso, erro: this.erro, total: this.total }
  }

  /** Baixa o que falta (um por vez) e confere. `onProgress(recebido, total)` soma os arquivos. */
  baixar({ onProgress = () => {} } = {}) {
    if (this.baixando) return this.baixando
    this.erro = null
    this.baixando = this.#baixar(onProgress)
      .catch((err) => {
        this.erro = err?.message || String(err)
        throw err
      })
      .finally(() => {
        this.baixando = null
      })
    return this.baixando
  }

  async #baixar(onProgress) {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const total = this.total
    let feito = 0
    for (const a of Object.values(this.arquivos)) {
      const final = path.join(this.dir, a.nome)
      const st = await fsp.stat(final).catch(() => null)
      if (st?.size === a.tamanho) {
        feito += a.tamanho
        continue
      }
      const tmp = `${final}.baixando`
      const tenta = async () => {
        const sha = await downloadTo(a.url, tmp, {
          ...(this.fetch ? { fetch: this.fetch } : {}),
          maxBytes: a.tamanho + 1024,
          onProgress: (got) => {
            this.progresso = { recebido: feito + got, total }
            onProgress(feito + got, total)
          },
        })
        if (sha !== a.sha256) throw new Error(`o arquivo ${a.nome} veio diferente do esperado`)
      }
      try {
        await tenta().catch(async (err) => {
          // Uma segunda tentativa (rede que caiu no meio de 135 MB é comum).
          await fsp.rm(tmp, { force: true })
          if (/diferente/.test(err?.message)) throw err
          await tenta()
        })
      } catch (err) {
        await fsp.rm(tmp, { force: true })
        throw new Error(`Não consegui baixar o modelo da busca: ${err?.message || err}`)
      }
      await fsp.rename(tmp, final)
      feito += a.tamanho
    }
    this.progresso = { recebido: total, total }
    onProgress(total, total)
    return this.caminhos()
  }

  async apagar() {
    await fsp.rm(this.dir, { recursive: true, force: true })
  }
}
