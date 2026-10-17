// Regras da tela Transferências sem interface (dá para testar no Node): filtros, integridade do lote e o rodapé
// do medidor ("1,7 GB andando · 42 GB parados").

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
