// Prévia de PSD/PSB (lib/psd.js): a miniatura que vem dentro do arquivo na hora, a imagem final em alta logo depois e,
// na parte de baixo, as pranchetas (tocar abre só ela) e a lista de camadas.
import { html, useEffect, useState } from '../vendor/preact-htm.js'
import { AUTO_COMPOSTA, camadasPsd, carregarImagem, desenharPsd, infoPsd, ordenarPranchetas, tamanhoDaImagem } from '../lib/psd.js'
import { MAX_COMPOSTA, MODOS } from '../lib/psd-ler.js'
import { bytes, count } from '../lib/format.js'
import { Icon } from './icons.js'
import { Button, cx } from './ui.js'

const telaPx = () => Math.min(2560, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(3, window.devicePixelRatio || 1)))
const chaveDe = (f) => `${f.shortcutDetails?.targetId || f.id}:${f.modifiedTime || ''}`

// ───── estado por arquivo (o palco e a parte de baixo leem o mesmo) ─────

const estados = new Map()
const ouvintes = new Map()
const novo = () => ({ fase: 'parado', progresso: null, imagem: null, erro: null, sel: -1, recortes: {}, miniPranchetas: {}, mini: undefined, cab: null, cam: null, tamanho: null })
const pegar = (k) => estados.get(k) || novo()
function mudar(k, patch) {
  const s = { ...pegar(k), ...(typeof patch === 'function' ? patch(pegar(k)) : patch) }
  estados.set(k, s)
  for (const fn of ouvintes.get(k) || []) fn(s)
  return s
}

export function usePsd(f) {
  const k = chaveDe(f)
  const [s, set] = useState(() => pegar(k))
  useEffect(() => {
    set(pegar(k))
    if (!ouvintes.has(k)) ouvintes.set(k, new Set())
    ouvintes.get(k).add(set)
    return () => ouvintes.get(k)?.delete(set)
  }, [k])
  return s
}

async function iniciar(f) {
  const k = chaveDe(f)
  if (pegar(k).fase !== 'parado') return
  mudar(k, { fase: 'lendo' })
  try {
    const info = await infoPsd(f)
    mudar(k, { mini: info.mini, cab: info.cab })
    const cam = await camadasPsd(f)
    mudar(k, { cam: { ...cam, pranchetas: ordenarPranchetas(cam.pranchetas) } })
    const tamanho = await tamanhoDaImagem(f)
    mudar(k, { tamanho })
    if (tamanho != null && tamanho > MAX_COMPOSTA) return mudar(k, { fase: 'grande' })
    if (tamanho != null && tamanho > AUTO_COMPOSTA) return mudar(k, { fase: 'pedir' })
    await abrir(f)
  } catch (err) {
    mudar(k, (s) => ({ fase: 'erro', erro: err?.message || 'erro', mini: s.mini ?? null }))
  }
}

export async function abrir(f) {
  const k = chaveDe(f)
  mudar(k, { fase: 'baixando', progresso: 0 })
  let ultimo = 0
  try {
    await carregarImagem(f, {
      onProgress: (p) => {
        const agora = Date.now()
        if (agora - ultimo > 150 || p === 1) {
          ultimo = agora
          mudar(k, { progresso: p })
        }
      },
    })
    mudar(k, { fase: 'desenhando', progresso: null })
    const imagem = await desenharPsd(f, { max: telaPx() })
    mudar(k, { fase: 'pronta', imagem })
    // Miniaturas das pranchetas, uma por vez.
    const lista = pegar(k).cam?.pranchetas || []
    for (let i = 0; i < lista.length; i++) {
      const url = await desenharPsd(f, { rect: lista[i].rect, max: 320 })
      mudar(k, (s) => ({ miniPranchetas: { ...s.miniPranchetas, [i]: url } }))
    }
  } catch (err) {
    mudar(k, (s) => ({ fase: s.imagem ? 'pronta' : 'erro', erro: err?.codigo || err?.message || 'erro' }))
  }
}

async function escolher(f, i) {
  const k = chaveDe(f)
  const s = pegar(k)
  if (i < 0 || s.recortes[i]) return mudar(k, { sel: i })
  mudar(k, { sel: i })
  try {
    await carregarImagem(f) // o worker guarda só o último PSD aberto
    const url = await desenharPsd(f, { rect: s.cam.pranchetas[i].rect, max: telaPx() })
    mudar(k, (x) => ({ recortes: { ...x.recortes, [i]: url } }))
  } catch {
    mudar(k, { sel: -1 })
  }
}

// ───── palco ─────

/** No lugar da foto: `Zoom` é o ZoomImage da prévia; `poster` é a miniatura do Google (quando existe). */
export function PsdStage({ file, poster, Zoom, onZoom }) {
  const s = usePsd(file)
  useEffect(() => {
    iniciar(file)
  }, [chaveDe(file)])
  const alta = s.sel >= 0 ? s.recortes[s.sel] || null : s.imagem
  const baixa = s.sel >= 0 ? s.miniPranchetas[s.sel] || null : poster || s.mini || null
  const src = alta || baixa
  const aviso =
    s.fase === 'baixando'
      ? html`<span class="spinner" aria-hidden="true"></span><span>Abrindo o PSD${s.progresso ? ` · ${Math.round(s.progresso * 100)}%` : '…'}</span>`
      : s.fase === 'lendo' || s.fase === 'desenhando' || (s.sel >= 0 && !alta)
        ? html`<span class="spinner" aria-hidden="true"></span><span>Abrindo…</span>`
        : s.fase === 'pedir'
          ? html`<${Button} size="sm" variant="secondary" icon="photo" onClick=${() => abrir(file)}>${`Abrir em alta · ${bytes(s.tamanho)}`}</${Button}>`
          : s.fase === 'grande'
            ? html`<span>PSD grande demais para abrir no celular${src ? '. Esta é a miniatura.' : '.'}</span>`
            : s.fase === 'erro' && !alta
              ? html`<span>${src ? 'Não deu para abrir em alta. Esta é a miniatura que vem no arquivo.' : 'Não deu para abrir este PSD aqui.'}</span>`
              : null
  return html`<div class="psd-stage">
    ${src
      ? html`<${Zoom} key=${src} src=${src} alt=${file.name} onZoom=${onZoom} />`
      : html`<div class="pv-wait">${s.fase === 'erro' || s.fase === 'grande' ? html`<${Icon} name="photo" size=${40} />` : html`<span class="spinner"></span>`}</div>`}
    ${aviso ? html`<div class=${cx('psd-aviso', s.fase === 'pedir' && 'is-acao')} role="status">${aviso}</div>` : null}
  </div>`
}

// ───── parte de baixo: pranchetas e camadas ─────

export function PsdPaginas({ file }) {
  const s = usePsd(file)
  const [verCamadas, setVerCamadas] = useState(false)
  const pr = s.cam?.pranchetas || []
  const cab = s.cab
  const resumo = cab ? [MODOS[cab.modo] || 'Modo desconhecido', `${cab.prof} bits`, `${count(cab.largura)} × ${count(cab.altura)}`, cab.psb ? 'PSB' : null].filter(Boolean).join(' · ') : null
  const camadas = s.cam?.camadas || []
  return html`<div class="psd-info">
    ${pr.length
      ? html`<h3 class="list-label">Pranchetas · ${pr.length}</h3>
          <div class="psd-pages" role="group" aria-label="Pranchetas">
            <button type="button" class=${cx('psd-page', s.sel < 0 && 'is-on')} onClick=${() => escolher(file, -1)} aria-pressed=${s.sel < 0 ? 'true' : 'false'}>
              <span class="psd-page-img">${s.imagem || s.mini ? html`<img src=${s.imagem || s.mini} alt="" />` : html`<${Icon} name="grid" size=${22} />`}</span>
              <span class="psd-page-name">Tudo</span>
            </button>
            ${pr.map(
              (p, i) => html`<button
                key=${i}
                type="button"
                class=${cx('psd-page', s.sel === i && 'is-on')}
                onClick=${() => escolher(file, i)}
                aria-pressed=${s.sel === i ? 'true' : 'false'}
                disabled=${!s.imagem}
              >
                <span class="psd-page-img">${s.miniPranchetas[i] ? html`<img src=${s.miniPranchetas[i]} alt="" />` : html`<${Icon} name="photo" size=${22} />`}</span>
                <span class="psd-page-name">${p.nome}</span>
                <span class="psd-page-sub">${p.rect.right - p.rect.left} × ${p.rect.bottom - p.rect.top}</span>
              </button>`,
            )}
          </div>`
      : null}
    ${resumo || camadas.length
      ? html`<div class="group psd-meta">
          ${resumo ? html`<div class="pv-meta-row"><dt>Photoshop</dt><dd>${resumo}</dd></div>` : null}
          ${camadas.length
            ? html`<button type="button" class="pv-meta-row psd-camadas-btn" onClick=${() => setVerCamadas(!verCamadas)} aria-expanded=${verCamadas ? 'true' : 'false'}>
                <dt>Camadas</dt>
                <dd>${count(camadas.length)}${s.cam.parcial ? '+' : ''} <${Icon} name=${verCamadas ? 'chevron-up' : 'chevron-down'} size=${14} strokeWidth=${2} /></dd>
              </button>`
            : null}
          ${verCamadas
            ? html`<ul class="psd-camadas">
                ${camadas.slice(0, 400).map(
                  (c, i) => html`<li key=${i} class=${cx(c.oculta && 'is-oculta')} style=${`padding-left:${14 + Math.min(c.nivel, 8) * 16}px`}>
                    <${Icon} name=${c.prancheta ? 'grid' : c.grupo ? 'folder' : 'photo'} size=${15} />
                    <span>${c.nome}</span>
                  </li>`,
                )}
              </ul>`
            : null}
        </div>`
      : null}
  </div>`
}
