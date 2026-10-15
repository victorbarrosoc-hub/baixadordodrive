// Avisos rápidos (canto inferior direito). Estado próprio, fora do store, para qualquer módulo poder avisar.
import { useEffect, useState } from '/vendor/preact-htm.js'

let toasts = []
let seq = 0
const subs = new Set()
const timers = new Map()

function emit() {
  for (const fn of subs) fn(toasts)
}

/**
 * @param {'success'|'error'|'info'|'warning'} kind
 * @param {string} message
 * @param {{ action?: { label: string, href?: string, onClick?: () => void }, duration?: number, title?: string }} [opts]
 */
export function toast(kind, message, opts = {}) {
  if (!message) return null
  // não empilha o mesmo erro várias vezes
  const dup = toasts.find((t) => t.message === message && t.kind === kind)
  if (dup) {
    schedule(dup.id, opts.duration ?? defaultDuration(kind))
    return dup.id
  }
  const id = ++seq
  toasts = [...toasts, { id, kind: kind || 'info', message, title: opts.title || null, action: opts.action || null }].slice(-5)
  emit()
  schedule(id, opts.duration ?? defaultDuration(kind))
  return id
}

function defaultDuration(kind) {
  return kind === 'error' ? 8000 : kind === 'warning' ? 7000 : 5000
}

function schedule(id, ms) {
  clearTimeout(timers.get(id))
  timers.set(id, setTimeout(() => dismiss(id), ms))
}

export function holdToast(id) {
  clearTimeout(timers.get(id))
}

export function releaseToast(id) {
  schedule(id, 2500)
}

export function dismiss(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  const before = toasts.length
  toasts = toasts.filter((t) => t.id !== id)
  if (toasts.length !== before) emit()
}

export function useToasts() {
  const [list, setList] = useState(toasts)
  useEffect(() => {
    subs.add(setList)
    return () => subs.delete(setList)
  }, [])
  return list
}
