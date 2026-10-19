// Zoom do app de desktop: em tela grande o app cresce junto (letras, botões, miniaturas), como um site bem feito
// numa tela de 27". Até 1600 px de janela fica no tamanho real; daí cresce devagar até 1,3× em 2560 px e para em
// 1,4×. O menu Visualizar (Aumentar, Diminuir, Tamanho real; Cmd/Ctrl +, -, 0) multiplica por cima, e a escolha da
// pessoa fica gravada em <userData>/zoom.json. Tudo pelo zoom do próprio Chromium (setZoomFactor): o layout, os
// cliques e as medidas da interface continuam batendo, diferente de um `zoom` no CSS.
import fs from 'node:fs'
import path from 'node:path'

export const ZOOM_BASE_PX = 1600
export const ZOOM_MAX = 1.4
const PASSOS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** Zoom automático para uma janela de `largura` px (conteúdo, em pixels da tela, sem o zoom). */
export function zoomAutomatico(largura) {
  const w = Number(largura) || 0
  if (w <= ZOOM_BASE_PX) return 1
  return Math.min(ZOOM_MAX, Math.round((1 + (w - ZOOM_BASE_PX) / 3200) * 100) / 100)
}

/** Próximo passo do zoom da pessoa (1 = sem mudança). `direcao`: +1, -1 ou 0 (volta para 1). */
export function proximoPasso(atual, direcao) {
  if (!direcao) return 1
  const i = PASSOS.findIndex(p => p >= atual - 1e-6)
  const at = i < 0 ? PASSOS.length - 1 : i
  const exato = Math.abs(PASSOS[at] - atual) < 1e-6
  if (direcao > 0) return PASSOS[Math.min(PASSOS.length - 1, exato ? at + 1 : at)]
  return PASSOS[Math.max(0, at - 1)]
}

/** Lê o zoom escolhido pela pessoa; qualquer coisa estranha vira 1. */
export function lerEscolha(arquivo) {
  try {
    const v = Number(JSON.parse(fs.readFileSync(arquivo, 'utf8'))?.pessoa)
    return Number.isFinite(v) && v >= PASSOS[0] && v <= PASSOS[PASSOS.length - 1] ? v : 1
  } catch {
    return 1
  }
}

/**
 * Liga o zoom automático numa janela. Devolve { aumentar, diminuir, tamanhoReal } para o menu.
 * @param {import('electron').BrowserWindow} win
 * @param {{ userData: string }} o
 */
export function ligarZoom(win, { userData }) {
  const arquivo = path.join(userData, 'zoom.json')
  let pessoa = lerEscolha(arquivo)
  let timer = null
  const aplicar = () => {
    if (win.isDestroyed()) return
    const fator = Math.round(zoomAutomatico(win.getContentBounds().width) * pessoa * 100) / 100
    if (Math.abs(win.webContents.getZoomFactor() - fator) > 0.005) win.webContents.setZoomFactor(fator)
  }
  const depois = () => {
    clearTimeout(timer)
    timer = setTimeout(aplicar, 120)
  }
  const escolher = direcao => {
    pessoa = proximoPasso(pessoa, direcao)
    try {
      fs.writeFileSync(arquivo, JSON.stringify({ pessoa }))
    } catch {
      // sem gravar: vale até fechar o app
    }
    aplicar()
  }
  win.on('resize', depois)
  win.webContents.on('did-finish-load', aplicar)
  // Cmd/Ctrl + rodinha ou pinça mudam o zoom do Chromium por fora: volta ao nosso na próxima mudança de tamanho.
  win.webContents.on('zoom-changed', (_e, sentido) => escolher(sentido === 'in' ? 1 : -1))
  aplicar()
  return { aumentar: () => escolher(1), diminuir: () => escolher(-1), tamanhoReal: () => escolher(0) }
}
