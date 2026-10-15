// Espera com recuo exponencial e "jitter" (aleatoriedade), como o Google recomenda.

/** Atraso para a tentativa `attempt` (0, 1, 2...): exponencial com jitter total, limitado a `max`. */
export function backoffDelay(attempt, { base = 1000, max = 64_000 } = {}) {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt))
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

export function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const err = new Error('Operação interrompida')
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 'UND_ERR_ABORTED')
}

/** setTimeout em forma de promessa que respeita AbortSignal. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
