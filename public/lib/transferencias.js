// Regras da tela Transferências sem interface (dá para testar no Node): filtros, integridade do lote e o rodapé
// do medidor ("1,7 GB andando · 42 GB parados").

const RANK = { running: 0, verifying: 0, failed: 1, waiting: 2, paused: 3, queued: 4, completed: 5, skipped: 5, canceled: 6 }

/**
 * Ordem das linhas de um lote: andando, com problema, esperando, pausado, na fila, concluído, cancelado.
 * Na fila, a mesma ordem do motor: prioridade e, no envio, o maior arquivo primeiro (no mesmo lote e na mesma
 * prioridade o motor sobe o maior antes); depois a ordem de entrada.
 */
export function sortRows(a, b) {
  const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
  if (r) return r
  if (a.status === 'queued') {
    const p = (b.priority || 0) - (a.priority || 0)
    if (p) return p
    if (a.type === 'upload' && b.type === 'upload' && a.batchId === b.batchId) {
      const s = (b.size || 0) - (a.size || 0)
      if (s) return s
    }
  }
  return (a.createdAt || 0) - (b.createdAt || 0) || (a.name < b.name ? -1 : 1)
}

/** Pausado com motivo (acesso vencido, disco cheio…): não volta sozinho, alguém precisa agir. */
export function needsYou(t) {
  return t.status === 'paused' && !!t.error
}

export const FILTER_TESTS = {
  all: () => true,
  // "Pausado · precisa de você" não conta aqui: vai para "Com problema", junto com o que falhou.
  active: (t) => t.status === 'running' || t.status === 'verifying' || t.status === 'waiting' || (t.status === 'paused' && !t.error),
  queued: (t) => t.status === 'queued',
  done: (t) => t.status === 'completed' || t.status === 'skipped',
  failed: (t) => t.status === 'failed' || t.verify?.state === 'mismatch' || needsYou(t),
}

/**
 * Integridade do lote, pelo que o motor já sabe de cada item concluído: `verify.state` 'ok' é MD5 conferido;
 * 'mismatch' chegou diferente; o resto (conferência desligada, Doc Google, arquivo sem MD5) ficou sem conferência.
 */
export function integrity(items) {
  let total = 0
  let checked = 0
  let mismatch = 0
  for (const t of items) {
    if (t.status !== 'completed' && t.status !== 'skipped') continue
    total++
    if (t.verify?.state === 'ok') checked++
    else if (t.verify?.state === 'mismatch') mismatch++
  }
  return { total, checked, mismatch, unchecked: total - checked - mismatch }
}

/** "9 de 9 conferidos (MD5)" · "8 de 9 conferidos · 1 sem conferência" · "… · 1 chegou diferente". */
export function integrityLabel({ total, checked, mismatch, unchecked }) {
  if (!total) return null
  if (checked === total) return `${total} de ${total} ${total === 1 ? 'conferido' : 'conferidos'} (MD5)`
  const parts = [`${checked} de ${total} ${total === 1 ? 'conferido' : 'conferidos'}`]
  if (mismatch) parts.push(`${mismatch} ${mismatch === 1 ? 'chegou diferente' : 'chegaram diferentes'}`)
  if (unchecked) parts.push(`${unchecked} sem conferência`)
  return parts.join(' · ')
}

/**
 * Rodapé do medidor a partir de stats.totals: o que anda (mesma conta do ETA) e o que está parado, à parte.
 * Motor antigo sem `remaining`: cai na conta de antes (tudo o que falta).
 */
export function meterTotals(totals = {}) {
  const all = Math.max(0, (totals.bytes || 0) - (totals.doneBytes || 0))
  const moving = typeof totals.remaining === 'number' ? Math.max(0, totals.remaining) : all
  return { moving, parked: Math.max(0, totals.parked || 0), parkedCount: totals.parkedCount || 0, problems: totals.problems || 0 }
}

/**
 * A pasta do Drive para mandar o link de um envio concluído. Uma pasta enviada inteira ("CAM_A → Diária 02") vira a
 * própria pasta nova (CAM_A, criada no Drive); arquivos soltos, a pasta de destino. Só envios (download não tem pasta
 * no Drive) e só com todos os arquivos indo para o mesmo destino. Devolve { id, name, driveId, accountId } ou null.
 * `id` 'root' = Meu Drive (abre, mas não tem link para mandar).
 */
export function batchFolder(items, batch = {}) {
  const ups = (items || []).filter((t) => t.type === 'upload' && t.status !== 'canceled' && t.target?.rootId)
  if (!ups.length) return null
  const { rootId, driveId = null } = ups[0].target
  const accountId = ups[0].accountId || batch.accountId || null
  if (ups.some((t) => t.target.rootId !== rootId || (t.target.driveId || null) !== (driveId || null) || (t.accountId || null) !== accountId)) return null
  const tops = new Set(ups.map((t) => String(t.target.relDir || '').split('/')[0]))
  const [top] = tops
  if (tops.size === 1 && top) {
    // A pasta nova: o id vem de quem foi direto para ela (parentId é a pasta que recebeu o arquivo).
    const direct = ups.find((t) => t.target.relDir === top && t.target.parentId)
    if (direct) return { id: direct.target.parentId, name: top, driveId: driveId || null, accountId }
  }
  const name = rootId === 'root' && !driveId ? 'Meu Drive' : batch.destino || (rootId === driveId ? 'drive compartilhado' : 'pasta de destino')
  return { id: rootId, name, driveId: driveId || null, accountId }
}

/**
 * Onde um lote de download está caindo no computador: { dir, target, name }. `dir` é a pasta comum a todos os
 * arquivos (a pasta baixada, "…/SSD/ZRO"); `target` é o que o Finder/Explorer mostra selecionado para abrir essa pasta:
 * um arquivo que está nela (o pronto, ou o temporário de quem está baixando), ou a própria pasta. Cancelados não
 * contam. Sem caminho conhecido: null.
 */
export function batchLocal(items) {
  const downs = (items || []).filter((t) => t.type === 'download' && t.status !== 'canceled' && t.dest?.path)
  if (!downs.length) return null
  const sep = downs[0].dest.path.includes('\\') && !downs[0].dest.path.includes('/') ? '\\' : '/'
  const split = (p) => String(p).split(/[\\/]/)
  let common = split(downs[0].dest.path).slice(0, -1)
  for (const t of downs.slice(1)) {
    const d = split(t.dest.path).slice(0, -1)
    let i = 0
    while (i < common.length && i < d.length && common[i] === d[i]) i++
    common = common.slice(0, i)
  }
  if (common.length <= 1) return null
  const dir = common.join(sep)
  const here = (t) => split(t.dest.path).slice(0, -1).join(sep) === dir
  const pronto = downs.find((t) => here(t) && t.status === 'completed')
  const indo = downs.find((t) => here(t) && t.dest.tempPath && (t.status === 'running' || t.status === 'verifying'))
  const target = pronto ? pronto.dest.path : indo ? indo.dest.tempPath : dir
  return { dir, target, name: common[common.length - 1] }
}
