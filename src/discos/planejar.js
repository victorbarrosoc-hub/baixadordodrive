// Antes de copiar: lê a origem, olha cada destino e diz, arquivo por arquivo, o que é novo, o que já está lá (mesmo
// nome e tamanho) e o que existe com outro tamanho. Também confere o espaço livre de cada destino.
// A origem vai para dentro de "<destino>/<nome>" (o nome da pasta, ou o que a pessoa escrever).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { scanLocal } from '../local/scan.js'
import { expandHome, mapLimit } from '../local/fsbrowse.js'

// Pastas que o Mac e o Windows criam na raiz dos discos: não são da câmera nem do projeto.
export const SISTEMA = /^(\.Spotlight-V100|\.fseventsd|\.Trashes|\.TemporaryItems|\.DocumentRevisions-V100|\.PKInstallSandboxManager|System Volume Information|\$RECYCLE\.BIN)(\/|$)/i

export class DiscosError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'DiscosError'
    this.status = status
  }
}

/** Nome de pasta seguro (sem barra, controle ou "..", até 120). Vazio → null. */
export function nomeDePasta(v) {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^[.\s]+|[.\s]+$/g, '') // sem ponto no começo (oculta) nem no fim (o Windows não aceita)
  return s || null
}

/** O nome que a pasta ganha no destino: o da origem (raiz de disco no Windows: a letra). */
export function nomePadrao(origem) {
  const b = path.basename(origem)
  if (b) return nomeDePasta(b) || 'Copia'
  const letra = /^([a-z]):/i.exec(origem)?.[1]
  return letra ? `Disco ${letra.toUpperCase()}` : 'Copia'
}

const dentro = (pai, filho) => {
  const r = path.relative(pai, filho)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

async function livreEm(dir) {
  try {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/**
 * @param {{ origem: string, destinos: string[], nome?: string, signal?: AbortSignal, onProgress?: Function }} o
 * @returns {Promise<{ origem: object, nome: string, destinos: object[], itens: object[], ignorados: object[] }>}
 */
export async function planejar({ origem, destinos, nome, signal, onProgress }) {
  if (typeof origem !== 'string' || !origem) throw new DiscosError(400, 'Escolha a pasta ou o disco de origem.')
  if (!Array.isArray(destinos) || !destinos.length) throw new DiscosError(400, 'Escolha pelo menos um destino.')
  if (destinos.length > 4) throw new DiscosError(400, 'No máximo 4 destinos por vez.')
  const org = expandHome(origem)
  const pasta = nomeDePasta(nome) || nomePadrao(org)
  const dests = []
  for (const d of destinos) {
    if (typeof d !== 'string' || !d) throw new DiscosError(400, 'Destino inválido.')
    const abs = expandHome(d)
    let st
    try {
      st = await fsp.stat(abs)
    } catch {
      throw new DiscosError(404, `O destino ${abs} não está acessível. O disco está conectado?`)
    }
    if (!st.isDirectory()) throw new DiscosError(400, `${abs} não é uma pasta.`)
    const final = path.join(abs, pasta)
    if (dentro(org, abs) || dentro(org, final)) throw new DiscosError(400, 'O destino não pode ficar dentro da origem.')
    if (dentro(final, org)) throw new DiscosError(400, 'A origem não pode ficar dentro do destino.')
    if (dests.some((x) => x.pasta === final)) throw new DiscosError(400, 'O mesmo destino foi escolhido duas vezes.')
    dests.push({ caminho: abs, pasta: final })
  }

  const lido = await scanLocal(org, { signal, onProgress: (p) => onProgress?.({ fase: 'origem', ...p }) })
  if (!lido.root.isDir) throw new DiscosError(400, 'Escolha uma pasta ou um disco (não um arquivo).')
  const arquivos = lido.files.filter((f) => !SISTEMA.test(f.relPath)).sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  const bytes = arquivos.reduce((s, f) => s + f.size, 0)

  const itens = arquivos.map((f) => ({ relPath: f.relPath, caminho: f.path, size: f.size, mtimeMs: f.mtimeMs, estados: [] }))
  const resumo = []
  for (let di = 0; di < dests.length; di++) {
    const d = dests[di]
    let feitos = 0
    const r = { caminho: d.caminho, pasta: d.pasta, novos: 0, iguais: 0, diferentes: 0, bytesNovos: 0, bytesDiferentes: 0, livre: await livreEm(d.caminho) }
    await mapLimit(itens, 16, async (it) => {
      if (signal?.aborted) return
      let estado = 'novo'
      try {
        const s = await fsp.stat(path.join(d.pasta, ...it.relPath.split('/')))
        estado = s.isFile() && s.size === it.size ? 'igual' : 'diferente'
      } catch {
        estado = 'novo'
      }
      it.estados[di] = estado
      if (estado === 'novo') (r.novos++, (r.bytesNovos += it.size))
      else if (estado === 'igual') r.iguais++
      else (r.diferentes++, (r.bytesDiferentes += it.size))
      if (++feitos % 200 === 0) onProgress?.({ fase: 'destino', destino: di, feitos, total: itens.length })
    })
    if (signal?.aborted) throw new DiscosError(499, 'Cancelado.')
    resumo.push(r)
  }
  return {
    origem: { caminho: org, nome: lido.root.name, arquivos: itens.length, bytes },
    nome: pasta,
    destinos: resumo,
    itens,
    ignorados: lido.skipped.slice(0, 200),
  }
}
