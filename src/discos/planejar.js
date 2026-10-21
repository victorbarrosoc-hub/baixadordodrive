// Antes de copiar: lê a origem, olha cada destino e diz, arquivo por arquivo, o que é novo, o que já está lá (mesmo
// nome e tamanho) e o que existe com outro tamanho. Também confere o espaço livre de cada destino.
// A origem vai para dentro de "<destino>/<nome>" (o nome da pasta, ou o que a pessoa escrever).
// Com `procurarTudo`, o que não está no caminho esperado é procurado no destino inteiro, em qualquer pasta, pelo nome
// e pelo tamanho (estado 'outro', com o caminho em `achados[di]`): já está nessa mídia, não precisa copiar de novo.
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

// Arquivo pequeno com o mesmo nome e tamanho e outra data pode ser outro arquivo (índices de câmera como STATUS.BIN
// têm tamanho fixo): só conta como "já está lá" com a mesma data. Daqui para cima, nome e tamanho bastam.
const PEQUENO = 1024 * 1024
const FOLGA_DATA_MS = 2000 // FAT/exFAT guardam a hora de 2 em 2 s
const PARCIAL_OU_GUARDADO = /(\.sobedesce-parcial$|(^|\/)\.sobedesce-anteriores(\/|$))/

const chave = (nome, size) => `${String(nome).normalize('NFC').toLowerCase()}|${size}`

/**
 * Tudo o que existe no destino (a pasta escolhida inteira), por nome + tamanho. Pula a própria origem (quando ela
 * fica dentro do destino), as pastas do sistema e o que a cópia deixa pela metade ou guardado.
 */
async function indiceDoDestino(raiz, { origem, signal }) {
  const lido = await scanLocal(raiz, { signal })
  const mapa = new Map()
  for (const f of lido.files) {
    if (SISTEMA.test(f.relPath) || PARCIAL_OU_GUARDADO.test(f.relPath) || dentro(origem, f.path)) continue
    const k = chave(path.basename(f.relPath), f.size)
    const l = mapa.get(k)
    if (l) l.push(f)
    else mapa.set(k, [f])
  }
  return mapa
}

/** O arquivo da origem já existe em outra pasta do destino? Devolve o caminho (o de mesma data primeiro) ou null. */
function acharEmOutraPasta(indice, it) {
  const l = indice.get(chave(path.basename(it.relPath), it.size))
  if (!l) return null
  const mesmaData = l.find((f) => Math.abs((f.mtimeMs || 0) - (it.mtimeMs || 0)) <= FOLGA_DATA_MS)
  if (mesmaData) return mesmaData.path
  return it.size >= PEQUENO ? l[0].path : null
}

/** A pasta da origem (relativa) de um arquivo: "Card 01/CLIP/C0055.MP4" → "Card 01/CLIP". */
const pastaRel = (relPath) => {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

/**
 * Para cada pasta da origem com arquivos achados em outra pasta do destino, a pasta do destino onde estão mais deles.
 * Os novos dessa pasta (ou de uma subpasta dela) vão para lá, com o resto do caminho. Se já existir um arquivo com esse
 * nome lá (outro tamanho), fica no caminho de sempre. Marca `it.para[di]` e conta em `r.juntos`.
 */
async function juntarAosVizinhos(itens, di, r) {
  const votos = new Map() // pasta da origem → Map(pasta do destino → quantos)
  for (const it of itens) {
    if (it.estados[di] !== 'outro') continue
    const de = pastaRel(it.relPath)
    const para = path.dirname(it.achados[di])
    const m = votos.get(de) || new Map()
    m.set(para, (m.get(para) || 0) + 1)
    votos.set(de, m)
  }
  if (!votos.size) return
  const escolhida = new Map()
  for (const [de, m] of votos) {
    const [melhor] = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    escolhida.set(de, melhor[0])
  }
  for (const it of itens) {
    if (it.estados[di] !== 'novo') continue
    // A pasta mais próxima (ela mesma ou uma acima) que já tem vizinhos no destino.
    let de = pastaRel(it.relPath)
    let resto = ''
    while (!escolhida.has(de) && de) {
      const i = de.lastIndexOf('/')
      resto = (i < 0 ? de : de.slice(i + 1)) + (resto ? `/${resto}` : '')
      de = i < 0 ? '' : de.slice(0, i)
    }
    if (!escolhida.has(de)) continue
    const alvo = path.join(escolhida.get(de), ...(resto ? resto.split('/') : []), path.basename(it.relPath))
    try {
      await fsp.stat(alvo)
      continue // já existe um com esse nome lá (e outro tamanho, senão teria sido achado): não mexe
    } catch {}
    ;(it.para ||= [])[di] = alvo
    r.juntos++
  }
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
export async function planejar({ origem, destinos, nome, signal, onProgress, procurarTudo = false }) {
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
    const r = { caminho: d.caminho, pasta: d.pasta, novos: 0, iguais: 0, diferentes: 0, emOutro: 0, juntos: 0, bytesNovos: 0, bytesIguais: 0, bytesDiferentes: 0, bytesEmOutro: 0, livre: await livreEm(d.caminho) }
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
      else if (estado === 'igual') (r.iguais++, (r.bytesIguais += it.size))
      else (r.diferentes++, (r.bytesDiferentes += it.size))
      if (++feitos % 200 === 0) onProgress?.({ fase: 'destino', destino: di, feitos, total: itens.length })
    })
    if (signal?.aborted) throw new DiscosError(499, 'Cancelado.')
    // O que é "novo" no caminho esperado ainda pode estar em outra pasta dessa mídia (copiado antes à mão, com outra
    // organização): procura no destino inteiro.
    if (procurarTudo && r.novos) {
      onProgress?.({ fase: 'procurando', destino: di })
      let indice
      try {
        indice = await indiceDoDestino(d.caminho, { origem: org, signal })
      } catch (err) {
        if (signal?.aborted) throw new DiscosError(499, 'Cancelado.')
        indice = null // destino ilegível em parte: fica a comparação pelo caminho
      }
      if (indice) {
        for (const it of itens) {
          if (it.estados[di] !== 'novo') continue
          const achado = acharEmOutraPasta(indice, it)
          if (!achado) continue
          it.estados[di] = 'outro'
          ;(it.achados ||= [])[di] = achado
          r.novos--
          r.bytesNovos -= it.size
          r.emOutro++
          r.bytesEmOutro += it.size
        }
        // Os novos vão para junto dos vizinhos: se os outros arquivos da mesma pasta da origem já estão numa pasta do
        // destino (C054 e C056 em ".../Cam A"), o C055 que falta vai para lá também, e não para a pasta nova.
        await juntarAosVizinhos(itens, di, r)
      }
    }
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
