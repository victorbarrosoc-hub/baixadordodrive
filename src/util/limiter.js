// Limitador de banda (token bucket) compartilhado entre todas as conexões de uma direção.
import { sleep } from './backoff.js'

export class BandwidthLimiter {
  /** @param {number} bytesPerSecond 0 = sem limite */
  constructor(bytesPerSecond = 0) {
    this.setRate(bytesPerSecond)
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0)
    // Balde de no máximo ~250 ms de tráfego evita rajadas grandes depois de uma pausa.
    this.capacity = Math.max(64 * 1024, this.rate / 4)
    this.tokens = this.capacity
    this.last = Date.now()
  }

  get unlimited() {
    return this.rate === 0
  }

  #refill() {
    const now = Date.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.rate) / 1000)
    this.last = now
  }

  /** Espera até poder passar `bytes`. Resolve na hora se não houver limite. */
  async take(bytes, signal) {
    if (this.unlimited || bytes <= 0) return
    for (;;) {
      if (this.unlimited) return
      this.#refill()
      // Pedidos maiores que o balde passam quando ele enche (deixa o saldo negativo e paga depois).
      if (this.tokens >= Math.min(bytes, this.capacity)) {
        this.tokens -= bytes
        return
      }
      const missing = Math.min(bytes, this.capacity) - this.tokens
      await sleep(Math.max(5, Math.ceil((missing * 1000) / this.rate)), signal)
    }
  }
}
