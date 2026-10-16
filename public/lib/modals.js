// Janelas modais com API de promessa: `await pickLocal({ mode: 'folder' })` devolve o caminho ou null.
// O <ModalHost/> (components/modal.js) desenha a pilha.
import { useEffect, useState } from '/vendor/preact-htm.js'

let stack = []
let seq = 0
const subs = new Set()

function emit() {
  for (const fn of subs) fn(stack)
}

// Janelas de outras telas (ex.: "Gerar miniaturas") se registram aqui: o host as desenha sem importar o módulo
// delas (o que criaria um ciclo modal.js ⇄ tela).
const registered = new Map()

export function registerModal(type, Component) {
  registered.set(type, Component)
}

export function registeredModal(type) {
  return registered.get(type) || null
}

export function openModal(type, props = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    stack = [...stack, { id, type, props, resolve, opener: document.activeElement }]
    emit()
  })
}

export function closeModal(id, value = null) {
  const m = stack.find((x) => x.id === id)
  if (!m) return
  stack = stack.filter((x) => x.id !== id)
  emit()
  m.resolve(value)
  // devolve o foco para quem abriu
  setTimeout(() => {
    try {
      if (m.opener && document.contains(m.opener)) m.opener.focus({ preventScroll: true })
    } catch {}
  }, 0)
}

/** Fecha tudo (ex.: a pessoa trocou de tela com uma janela aberta). */
export function closeAllModals() {
  for (const m of [...stack].reverse()) closeModal(m.id, null)
}

export function useModalStack() {
  const [list, setList] = useState(stack)
  useEffect(() => {
    subs.add(setList)
    return () => subs.delete(setList)
  }, [])
  return list
}

/**
 * Seletor local.
 * mode 'files': vários arquivos e pastas → string[]
 * mode 'folder': uma pasta → string
 */
export const pickLocal = (props) => openModal('local', props)

/** Seletor de pasta do Drive → { id, name, path, driveId } */
export const pickDriveFolder = (props) => openModal('drive', props)

/** Confirmação → boolean */
export const confirmDialog = (props) => openModal('confirm', props).then(Boolean)

/** Pergunta um texto → string | null */
export const promptDialog = (props) => openModal('prompt', props)
