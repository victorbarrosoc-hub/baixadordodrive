// Medidor de velocidade: janela deslizante de baldes de 250 ms + média móvel para a tela não "pular".

const BUCKET_MS = 250

export class SpeedMeter {
  constructor({ windowMs = 4000, smoothing = 0.35 } = {}) {
    this.windowMs = windowMs
    this.smoothing = smoothing
    this.buckets = [] // [{ t, bytes }]
    this.total = 0
    this.smoothed = 0
    this.lastSample = 0
  }

  add(bytes, now = Date.now()) {
    if (!bytes) return
    this.total += bytes
    const t = now - (now % BUCKET_MS)
    const last = this.buckets[this.buckets.length - 1]
    if (last && last.t === t) last.bytes += bytes
    else this.buckets.push({ t, bytes })
    this.#trim(now)
  }

  #trim(now) {
    const cutoff = now - this.windowMs
    while (this.buckets.length && this.buckets[0].t < cutoff) this.buckets.shift()
  }

  /** Bytes/s brutos da janela. */
  rawRate(now = Date.now()) {
    this.#trim(now)
    if (!this.buckets.length) return 0
    const span = Math.max(1000, Math.min(this.windowMs, now - this.buckets[0].t))
    let sum = 0
    for (const b of this.buckets) sum += b.bytes
    return (sum * 1000) / span
  }

  /** Bytes/s suavizados (use para exibir). */
  rate(now = Date.now()) {
    const raw = this.rawRate(now)
    if (now - this.lastSample >= BUCKET_MS) {
      this.smoothed = this.smoothed === 0 ? raw : this.smoothed + this.smoothing * (raw - this.smoothed)
      if (raw === 0 && this.smoothed < 1024) this.smoothed = 0
      this.lastSample = now
    }
    return Math.round(this.smoothed)
  }

  reset() {
    this.buckets = []
    this.smoothed = 0
  }
}

/** Segundos estimados para terminar, ou null se não dá pra estimar. */
export function eta(remainingBytes, bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 1 || remainingBytes <= 0) return remainingBytes <= 0 ? 0 : null
  return Math.ceil(remainingBytes / bytesPerSecond)
}
