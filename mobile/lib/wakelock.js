// Tela acesa enquanto sobe (Screen Wake Lock API). O sistema solta a trava quando a página some;
// pedimos de novo ao voltar. Sem suporte ou sem permissão, segue sem ela (a tela avisa para manter aberta).
import { setState } from './state.js'

let sentinel = null
let wanted = false
let pending = null

export const wakeSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator

async function acquire() {
  if (!wakeSupported || sentinel || pending || document.visibilityState !== 'visible') return
  pending = navigator.wakeLock
    .request('screen')
    .then((s) => {
      sentinel = s
      setState({ awake: true })
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null
        setState({ awake: false })
      })
      if (!wanted) release()
    })
    .catch(() => setState({ awake: false }))
    .finally(() => {
      pending = null
    })
  await pending
}

function release() {
  const s = sentinel
  sentinel = null
  setState({ awake: false })
  if (s) s.release().catch(() => {})
}

export function keepAwake(on) {
  if (on === wanted) return
  wanted = on
  if (on) acquire()
  else release()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible') acquire()
  })
}
