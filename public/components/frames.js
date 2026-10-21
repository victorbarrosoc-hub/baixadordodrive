// Tela Frames (docs/FRAMES.md): do vídeo final aos frames, takes e posts.
//   #/frames          novo trabalho (vídeo do computador ou descido do Drive, ajustes, logomarca, onde fica) + histórico
//   #/frames/<id>     o trabalho: frames por cena (trocar, descartar, nome da cena), takes, posts; mostrar pasta e
//                     subir para o Drive
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { getState, setFrames, useStore } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, attempt, enc, withQuery } from '../lib/api.js'
import { cx, storage } from '../lib/ui.js'
import { bytes, plural, relTime, shortPath } from '../lib/format.js'
import { clipTime } from '../lib/media.js'
import { toast } from '../lib/toasts.js'
import { bridge, pathsFromDrop, pickFolderPath, revealLabel, revealPath } from '../lib/desktop.js'
import { openModal, pickDriveFolder, promptDialog } from '../lib/modals.js'
import { FUNDOS, LAYOUTS, ZOOM_MAX, desenharPost, enquadreDe, fatiar, frameNoPonto, layoutPorId, moverEnquadre } from '../lib/frames-posts.js'
import { Icon } from './icons.js'
import { Button, EmptyState, IconButton, Segmented, Slider, Spinner, Stepper, Switch } from './common.js'

const VIDEO_EXT = /\.(mp4|mov|m4v|mxf|mkv|avi|mts|m2ts|ts|mpg|mpeg|webm|wmv|3gp|dv)$/i
const LOGO_EXT = /\.(png|jpe?g|webp)$/i
const AJUSTES_PADRAO = {
  frames: { quantidade: 24, formato: 'jpg', logo: false },
  takes: { ligado: true, quantidade: 6, duracao: 3, formato: 'original', codec: 'h264', audio: true, logo: false },
  logo: null, // { path, posicao, tamanho, opacidade }
  nuvem: 'junto', // 'junto' | 'escolher' | 'nao'
}

const chave = () => getState().media?.key || ''
const arquivoUrl = (id, q) => withQuery(`/api/frames/${enc(id)}/arquivo`, { ...q, k: chave() })
const logoUrl = (p) => withQuery('/api/frames-logo', { p, k: chave() })
const juntar = (pasta, rel) => `${pasta}${pasta.includes('\\') ? '\\' : '/'}${rel}`
const tc = (s) => String(s || '').replace(/-/g, ':')
const nomeSemExt = (n) => String(n || '').replace(/\.[^.]{1,6}$/, '')

// ─────────── novo trabalho ───────────

function OrigemTile({ icon, titulo, dica, tag, onClick, ativo, tom }) {
  return html`<button type="button" class=${cx('fr-origem', tom && `is-${tom}`, ativo && 'is-on')} onClick=${onClick}>
    <span class="fr-origem-ic"><${Icon} name=${icon} size=${22} /></span>
    <span class="fr-origem-txt"><b>${titulo}</b><span>${dica}</span></span>
    ${tag ? html`<span class="fr-origem-tag">${tag}</span>` : null}
  </button>`
}

function LogoPosicao({ value, onChange }) {
  const pos = [
    ['sup-esq', 'Em cima, à esquerda'],
    ['sup-dir', 'Em cima, à direita'],
    ['centro', 'No meio'],
    ['inf-esq', 'Embaixo, à esquerda'],
    ['inf-dir', 'Embaixo, à direita'],
  ]
  return html`<div class="fr-logo-pos" role="radiogroup" aria-label="Posição da logomarca">
    ${pos.map(([v, t]) => html`<button type="button" role="radio" aria-checked=${value === v ? 'true' : 'false'} title=${t} aria-label=${t} class=${cx('fr-logo-dot', `is-${v}`, value === v && 'is-on')} onClick=${() => onChange(v)}></button>`)}
  </div>`
}

function LogoPrevia({ logo }) {
  const style = useMemo(() => {
    const p = logo.posicao
    const m = '4%'
    const s = { width: `${Math.round(logo.tamanho * 100)}%`, opacity: logo.opacidade }
    if (p === 'centro') Object.assign(s, { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' })
    else {
      s[p.endsWith('esq') ? 'left' : 'right'] = m
      s[p.startsWith('sup') ? 'top' : 'bottom'] = '5%'
    }
    return Object.entries(s).map(([k, v]) => `${k}:${v}`).join(';')
  }, [logo])
  return html`<div class="fr-logo-tela" aria-hidden="true">
    <span class="fr-logo-luz"></span>
    <img src=${logoUrl(logo.path)} alt="" style=${style} />
  </div>`
}

function Passo({ n, titulo, dica, opcional, acao, children }) {
  return html`<section class="frn-passo">
    <header class="frn-passo-head">
      <span class="frn-n">${n}</span>
      <div class="frn-passo-tit">
        <h2>${titulo}${opcional ? html` <small>opcional</small>` : null}</h2>
        ${dica ? html`<p>${dica}</p>` : null}
      </div>
      ${acao ? html`<div class="frn-passo-acao">${acao}</div>` : null}
    </header>
    <div class="frn-passo-corpo">${children}</div>
  </section>`
}

/** Desenho da proporção (16:9, 9:16, 4:5, 1:1) para as opções de formato. */
function Arte({ proporcao }) {
  const [w, h] = proporcao.split(':').map(Number)
  const k = 26 / Math.max(w, h)
  return html`<span class="frn-arte" aria-hidden="true"><i style=${`width:${Math.round(w * k)}px;height:${Math.round(h * k)}px`}></i></span>`
}

/** Opções grandes, lado a lado: o rótulo, uma linha de dica e, se houver, um ícone ou o desenho da proporção. */
function Escolha({ value, opcoes, onChange, label, tom }) {
  return html`<div class=${cx('frn-escolha', tom && `is-${tom}`)} role="radiogroup" aria-label=${label} style=${`--n:${opcoes.length}`}>
    ${opcoes.map(
      (o) => html`<button type="button" role="radio" aria-checked=${o.value === value ? 'true' : 'false'} class=${cx('frn-op', o.value === value && 'is-on')} onClick=${() => onChange(o.value)}>
        ${o.arte ? html`<${Arte} proporcao=${o.arte} />` : o.icon ? html`<span class="frn-op-ic"><${Icon} name=${o.icon} size=${16} /></span>` : null}
        <b>${o.label}</b>
        ${o.dica ? html`<span>${o.dica}</span>` : null}
        <span class="frn-op-ok" aria-hidden="true"><${Icon} name="check" size=${12} /></span>
      </button>`,
    )}
  </div>`
}

/** "O que vai sair": o resumo ao vivo do trabalho, com os frames, os takes e o caminho até a nuvem desenhados. */
function Resumo({ video, aj, nuvem, pastaDrive, busy, onComecar }) {
  const nf = aj.frames.quantidade
  const mostra = Math.min(nf, 24)
  const takes = aj.takes.ligado ? aj.takes.quantidade : 0
  const [tw, th] = (aj.takes.formato === 'original' ? '16:9' : aj.takes.formato).split(':').map(Number)
  const destinoNuvem = nuvem === 'junto' ? 'Ao lado do vídeo' : nuvem === 'escolher' && pastaDrive ? pastaDrive.name : null
  return html`<div class="frn-resumo">
    <p class="frn-resumo-tit">O que vai sair</p>
    <div class="frn-bloco is-frames">
      <div class="frn-bloco-top"><b>${nf}</b><span>frames · ${aj.frames.formato.toUpperCase()}</span></div>
      <div class="frn-mosaico" aria-hidden="true">
        ${Array.from({ length: mostra }, (_, i) => html`<i key=${`${nf}-${i}`} style=${`--i:${i}`}></i>`)}
        ${nf > mostra ? html`<em>+${nf - mostra}</em>` : null}
      </div>
    </div>
    <div class=${cx('frn-bloco is-takes', !takes && 'is-off')}>
      <div class="frn-bloco-top">${takes ? html`<b>${takes}</b><span>takes · ${aj.takes.duracao} s · ${aj.takes.codec === 'prores' ? 'ProRes' : 'H.264'}</span>` : html`<span>Sem takes</span>`}</div>
      ${takes
        ? html`<div class="frn-takes" aria-hidden="true">
            ${Array.from({ length: Math.min(takes, 8) }, (_, i) => html`<i key=${`${aj.takes.formato}-${i}`} style=${`--i:${i};aspect-ratio:${tw}/${th};height:${tw > th ? 30 : 46}px`}><span></span></i>`)}
          </div>`
        : null}
    </div>
    <div class=${cx('frn-fluxo', !destinoNuvem && 'is-local')}>
      <span class="frn-fluxo-no"><${Icon} name="desktop" size=${16} /><small>Computador</small></span>
      <span class="frn-fluxo-linha" aria-hidden="true"><i></i></span>
      <span class="frn-fluxo-no is-nuvem"><${Icon} name="cloud" size=${16} /><small>${destinoNuvem || 'Não sobe'}</small></span>
    </div>
    <button type="button" class="frn-cta" disabled=${!video || busy} onClick=${onComecar}>
      ${busy ? html`<${Spinner} size=${16} />` : html`<${Icon} name="sparkle" size=${18} />`}
      <span>Fazer frames${aj.takes.ligado ? ' e takes' : ''}</span>
    </button>
    <p class="frn-cta-dica">${video ? html`<b>${video.nome}</b>` : 'Escolha o vídeo para começar.'}</p>
  </div>`
}

function Novo({ onComecou }) {
  const accounts = useStore((s) => s.accounts)
  const activeAccountId = useStore((s) => s.activeAccountId)
  const settings = useStore((s) => s.settings)
  const [video, setVideo] = useState(null) // { tipo: 'local', caminho, nome } | { tipo: 'drive', accountId, fileId, nome, size, folderId, driveId }
  const [aj, setAj] = useState(() => {
    const s = storage.get('frames.ajustes', null)
    return s ? { ...AJUSTES_PADRAO, ...s, frames: { ...AJUSTES_PADRAO.frames, ...s.frames }, takes: { ...AJUSTES_PADRAO.takes, ...s.takes } } : AJUSTES_PADRAO
  })
  const [destino, setDestino] = useState(() => storage.get('frames.destino', null))
  const [pastaDrive, setPastaDrive] = useState(null) // { accountId, id, name, driveId }
  const [arrastando, setArrastando] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => storage.set('frames.ajustes', aj), [aj])
  const set = (k, v) => setAj((a) => ({ ...a, [k]: typeof v === 'object' && v && !Array.isArray(v) && a[k] ? { ...a[k], ...v } : v }))
  const padrao = `${settings?.downloadDir || '~/Downloads'}/Frames`
  const home = useStore((s) => s.app?.home)

  const doComputador = async () => {
    const list = bridge?.pickPaths ? await bridge.pickPaths({ title: 'Escolha o vídeo final', kind: 'files' }).catch(() => null) : null
    const p = list?.[0]
    if (!p) return
    if (!VIDEO_EXT.test(p)) return toast('error', 'Escolha um arquivo de vídeo (MP4, MOV, MXF…).')
    setVideo({ tipo: 'local', caminho: p, nome: p.split(/[\\/]/).pop() })
  }
  const doDrive = async () => {
    const accountId = activeAccountId || accounts[0]?.id
    if (!accountId) return toast('error', 'Conecte um Drive primeiro.')
    const it = await pickDriveFolder({ accountId, title: 'Escolha o vídeo final no Drive', arquivo: { nome: 'o vídeo', aceita: (x) => VIDEO_EXT.test(x.name || '') || /^video\//.test(x.mimeType || '') } })
    if (!it) return
    setVideo({ tipo: 'drive', accountId, fileId: it.id, nome: it.name, size: it.size, folderId: it.parents?.[0] || null, driveId: it.driveId || null })
  }
  const escolherLogo = async () => {
    const list = bridge?.pickPaths ? await bridge.pickPaths({ title: 'Escolha a logomarca (PNG com fundo transparente fica melhor)', kind: 'files' }).catch(() => null) : null
    const p = list?.[0]
    if (!p) return
    if (!LOGO_EXT.test(p)) return toast('error', 'A logomarca precisa ser PNG, JPG ou WebP.')
    setAj((a) => ({ ...a, logo: { posicao: 'inf-dir', tamanho: 0.14, opacidade: 0.9, ...(a.logo || {}), path: p }, frames: { ...a.frames, logo: true } }))
  }
  const onDrop = (e) => {
    e.preventDefault()
    setArrastando(false)
    const p = pathsFromDrop(e.dataTransfer).find((x) => VIDEO_EXT.test(x))
    const l = pathsFromDrop(e.dataTransfer).find((x) => LOGO_EXT.test(x))
    if (p) setVideo({ tipo: 'local', caminho: p, nome: p.split(/[\\/]/).pop() })
    else if (l) setAj((a) => ({ ...a, logo: { posicao: 'inf-dir', tamanho: 0.14, opacidade: 0.9, ...(a.logo || {}), path: l }, frames: { ...a.frames, logo: true } }))
    else toast('error', 'Solte um arquivo de vídeo (ou a imagem da logomarca).')
  }
  const trocarDestino = async () => {
    const p = await pickFolderPath({ title: 'Onde salvar os frames e takes?', defaultPath: destino || undefined })
    if (p) {
      setDestino(p)
      storage.set('frames.destino', p)
    }
  }
  const escolherPastaDrive = async () => {
    const accountId = video?.accountId || activeAccountId || accounts[0]?.id
    if (!accountId) return
    const r = await pickDriveFolder({ accountId, title: 'Subir a pasta pronta para…', destinos: true })
    if (r) {
      setPastaDrive({ accountId, id: r.id, name: r.name, driveId: r.driveId || null })
      set('nuvem', 'escolher')
    }
  }

  const nuvem = aj.nuvem === 'junto' && video?.tipo !== 'drive' ? (pastaDrive ? 'escolher' : 'nao') : aj.nuvem
  const comecar = async () => {
    if (!video) return
    if (nuvem === 'escolher' && !pastaDrive) return escolherPastaDrive()
    setBusy(true)
    const subir = nuvem === 'junto' ? 'junto' : nuvem === 'escolher' && pastaDrive ? { accountId: pastaDrive.accountId, folderId: pastaDrive.id, driveId: pastaDrive.driveId, name: pastaDrive.name } : null
    const res = await attempt(
      api.post('/api/frames', {
        origem: video.tipo === 'local' ? { tipo: 'local', caminho: video.caminho } : { tipo: 'drive', accountId: video.accountId, fileId: video.fileId },
        ajustes: {
          frames: aj.frames,
          takes: aj.takes.ligado ? { ...aj.takes } : null,
          logo: aj.logo,
          destino,
          subir,
        },
      }),
    )
    setBusy(false)
    if (res?.jobId) {
      onComecou?.(res.jobId)
      setVideo(null)
    }
  }

  const nuvemOpcoes = [
    ...(video?.tipo === 'drive' ? [{ value: 'junto', label: 'Ao lado do vídeo', dica: 'Na mesma pasta do Drive', icon: 'upload' }] : []),
    { value: 'escolher', label: pastaDrive ? pastaDrive.name : 'Escolher pasta', dica: pastaDrive ? 'Toque para trocar' : 'Uma pasta do Drive', icon: 'cloud' },
    { value: 'nao', label: 'Agora não', dica: 'Fica só no computador', icon: 'desktop' },
  ]

  return html`<section
    class=${cx('frn', arrastando && 'is-drop')}
    onDragOver=${(e) => {
      e.preventDefault()
      setArrastando(true)
    }}
    onDragLeave=${(e) => e.currentTarget.contains(e.relatedTarget) || setArrastando(false)}
    onDrop=${onDrop}
  >
    <div class="frn-main">
      <${Passo} n="1" titulo="O vídeo final" dica="O filme pronto, do computador ou do Drive.">
        ${video
          ? html`<div class="fr-video">
              <span class=${cx('fr-video-ic', video.tipo === 'drive' && 'is-drive')}><${Icon} name=${video.tipo === 'drive' ? 'cloud' : 'film'} size=${20} /></span>
              <span class="fr-video-txt">
                <b title=${video.nome}>${video.nome}</b>
                <span>${video.tipo === 'drive' ? `Desce do Drive${video.size ? ` · ${bytes(video.size)}` : ''} e é apagado do computador no fim` : shortPath(video.caminho, home)}</span>
              </span>
              <${Button} size="sm" onClick=${() => setVideo(null)}>Trocar</${Button}>
            </div>`
          : html`<div class="fr-origens">
                <${OrigemTile} icon="desktop" tom="local" titulo="Do computador" dica="Escolha ou arraste o arquivo" onClick=${doComputador} />
                <${OrigemTile} icon="cloud" tom="drive" titulo="Do Drive" dica="Desce, vira frames e sai do computador" tag="Desce" onClick=${doDrive} />
              </div>
              <p class="frn-arraste"><${Icon} name="drop" size=${14} />Ou solte o vídeo em qualquer lugar desta tela</p>`}
      </${Passo}>

      <${Passo} n="2" titulo="Frames" dica="Os melhores de cada cena, no tamanho do vídeo.">
        <div class="frn-quant">
          <div class="frn-quant-num"><b>${aj.frames.quantidade}</b><span>frames</span></div>
          <div class="frn-quant-ctl">
            <${Slider} value=${aj.frames.quantidade} min=${6} max=${120} step=${1} label="Quantidade de frames" format=${() => ''} onInput=${(v) => set('frames', { quantidade: v })} />
            <div class="frn-atalhos">${[12, 24, 48, 96].map((q) => html`<button type="button" class=${cx('frn-atalho', aj.frames.quantidade === q && 'is-on')} onClick=${() => set('frames', { quantidade: q })}>${q}</button>`)}</div>
          </div>
        </div>
        <${Escolha}
          label="Formato dos frames"
          value=${aj.frames.formato}
          onChange=${(v) => set('frames', { formato: v })}
          opcoes=${[
            { value: 'jpg', label: 'JPG', dica: 'Leve, qualidade máxima' },
            { value: 'png', label: 'PNG', dica: 'Sem perda' },
            { value: 'tiff', label: 'TIFF', dica: 'Para tratar a cor' },
          ]}
        />
      </${Passo}>

      <${Passo} n="3" titulo="Takes" dica="O melhor trecho de cada cena, pronto para as redes." acao=${html`<${Switch} checked=${aj.takes.ligado} label="Gerar takes" onChange=${(v) => set('takes', { ligado: v })} />`}>
        ${aj.takes.ligado
          ? html`<div class="frn-dupla">
                <div class="frn-campo"><span class="frn-rot">Quantos</span><${Stepper} value=${aj.takes.quantidade} min=${1} max=${30} label="Quantidade de takes" onChange=${(v) => set('takes', { quantidade: v })} /></div>
                <div class="frn-campo">
                  <span class="frn-rot">Duração</span>
                  <div class="frn-chips" role="radiogroup" aria-label="Duração dos takes">
                    ${[2, 3, 5, 8].map((v) => html`<button type="button" role="radio" aria-checked=${aj.takes.duracao === v ? 'true' : 'false'} class=${cx('frn-chip', aj.takes.duracao === v && 'is-on')} onClick=${() => set('takes', { duracao: v })}>${v} s</button>`)}
                  </div>
                </div>
                <div class="frn-campo"><span class="frn-rot">Som</span><${Switch} checked=${aj.takes.audio} label="Takes com som" onChange=${(v) => set('takes', { audio: v })} /></div>
              </div>
              <span class="frn-rot">Formato <small>recorta pelo centro</small></span>
              <${Escolha}
                label="Formato dos takes"
                value=${aj.takes.formato}
                onChange=${(v) => set('takes', { formato: v })}
                opcoes=${[
                  { value: 'original', label: 'Original', dica: 'Como foi filmado', arte: '16:9' },
                  { value: '9:16', label: '9:16', dica: 'Reels e Stories', arte: '9:16' },
                  { value: '4:5', label: '4:5', dica: 'Feed', arte: '4:5' },
                  { value: '1:1', label: '1:1', dica: 'Quadrado', arte: '1:1' },
                ]}
              />
              <span class="frn-rot">Arquivo</span>
              <${Escolha}
                label="Codec dos takes"
                value=${aj.takes.codec}
                onChange=${(v) => set('takes', { codec: v })}
                opcoes=${[
                  { value: 'h264', label: 'H.264', dica: 'Para postar', icon: 'upload' },
                  { value: 'prores', label: 'ProRes 422 HQ', dica: 'Para editar', icon: 'film' },
                ]}
              />`
          : html`<p class="fr-off">Só frames desta vez.</p>`}
      </${Passo}>

      <${Passo}
        n="4"
        titulo="Logomarca"
        opcional=${true}
        dica="Vai nos frames, nos takes e nos posts."
        acao=${aj.logo ? html`<${Button} size="sm" variant="ghost" onClick=${() => setAj((a) => ({ ...a, logo: null, frames: { ...a.frames, logo: false }, takes: { ...a.takes, logo: false } }))}>Tirar</${Button}>` : null}
      >
        ${aj.logo
          ? html`<div class="fr-logo">
              <${LogoPrevia} logo=${aj.logo} />
              <div class="fr-linhas">
                <div class="fr-linha"><span class="fr-rot">Onde</span><${LogoPosicao} value=${aj.logo.posicao} onChange=${(v) => set('logo', { posicao: v })} /></div>
                <div class="fr-linha"><span class="fr-rot">Tamanho</span><${Slider} value=${Math.round(aj.logo.tamanho * 100)} min=${5} max=${40} label="Tamanho da logomarca" format=${(v) => `${v}%`} onInput=${(v) => set('logo', { tamanho: v / 100 })} /></div>
                <div class="fr-linha"><span class="fr-rot">Opacidade</span><${Slider} value=${Math.round(aj.logo.opacidade * 100)} min=${10} max=${100} label="Opacidade da logomarca" format=${(v) => `${v}%`} onInput=${(v) => set('logo', { opacidade: v / 100 })} /></div>
                <div class="fr-linha">
                  <span class="fr-rot">Vai em</span>
                  <div class="fr-checks">
                    <label><${Switch} checked=${aj.frames.logo} label="Logo nos frames" onChange=${(v) => set('frames', { logo: v })} /> Frames</label>
                    <label><${Switch} checked=${aj.takes.logo} label="Logo nos takes" onChange=${(v) => set('takes', { logo: v })} /> Takes</label>
                  </div>
                </div>
              </div>
            </div>`
          : html`<button type="button" class="fr-logo-vazio" onClick=${escolherLogo}><span class="fr-logo-vazio-ic"><${Icon} name="plus" size=${16} /></span><b>Escolher a logomarca</b><span>PNG com fundo transparente fica melhor</span></button>`}
      </${Passo}>

      <${Passo} n="5" titulo="Sobe e desce" dica="Onde a pasta pronta fica e para onde ela sobe.">
        <div class="frn-pasta">
          <span class="frn-pasta-ic"><${Icon} name="folder" size=${18} /></span>
          <span class="frn-pasta-txt"><b>No computador</b><span title=${destino || padrao}>${shortPath(destino || padrao, home)} · uma pasta por cena</span></span>
          <${Button} size="sm" onClick=${trocarDestino}>Trocar</${Button}>
        </div>
        <span class="frn-rot">Na nuvem <small>a pasta pronta sobe sozinha</small></span>
        <${Escolha} tom="sobe" label="Subir para o Drive" value=${nuvem} onChange=${(v) => (v === 'escolher' ? escolherPastaDrive() : set('nuvem', v))} opcoes=${nuvemOpcoes} />
      </${Passo}>
    </div>

    <aside class="frn-lado">
      <${Resumo} video=${video} aj=${aj} nuvem=${nuvem} pastaDrive=${pastaDrive} busy=${busy} onComecar=${comecar} />
    </aside>
    ${arrastando ? html`<div class="fr-drop"><${Icon} name="drop" size=${28} /><b>Solte o vídeo aqui</b></div>` : null}
  </section>`
}

// ─────────── andamento ───────────

const FASES = { preparando: 'Preparando', baixando: 'Desce do Drive', lendo: 'Assistindo o filme', frames: 'Frames em alta', takes: 'Takes', pronto: 'Pronto' }

function Andamento({ job }) {
  if (!job) return null
  const rodando = job.status === 'running'
  if (!rodando && job.status !== 'error') return null
  const parar = () => attempt(api.del(`/api/frames/job/${enc(job.jobId)}`))
  const ordem = ['baixando', 'lendo', 'frames', 'takes']
  const atual = ordem.indexOf(job.fase)
  return html`<section class=${cx('fr-andamento', job.status === 'error' && 'is-erro')} aria-live="polite">
    <div class="fr-andamento-top">
      <div>
        <b>${job.video || 'Vídeo'}</b>
        <span>${job.status === 'error' ? job.erro : job.texto}</span>
      </div>
      ${rodando ? html`<${Button} size="sm" onClick=${parar}>Parar</${Button}>` : html`<${Button} size="sm" variant="ghost" onClick=${() => setFrames(null)}>OK</${Button}>`}
    </div>
    ${rodando
      ? html`<ol class="fr-fases">
          ${ordem.map(
            (f, i) => html`<li class=${cx(i < atual && 'is-feito', i === atual && 'is-agora')}>
              <span class="fr-fase-nome">${FASES[f]}</span>
              <span class="fr-fase-barra"><span style=${`width:${i < atual ? 100 : i === atual ? Math.round((job.frac || 0) * 100) : 0}%`}></span></span>
            </li>`,
          )}
        </ol>`
      : null}
  </section>`
}

// ─────────── histórico ───────────

function Historico({ lista }) {
  if (!lista?.length) return null
  return html`<section class="fr-hist">
    <h2 class="fr-sec-titulo">Seus trabalhos</h2>
    <div class="fr-hist-grade">
      ${lista.map(
        (h) => html`<a key=${h.id} class="fr-hist-card" href=${`#/frames/${enc(h.id)}`}>
          <span class="fr-hist-capa">${h.capa ? html`<img src=${arquivoUrl(h.id, { mini: h.capa })} alt="" loading="lazy" />` : html`<${Icon} name="film" size=${26} />`}</span>
          <span class="fr-hist-meta">
            <b title=${h.video?.nome}>${nomeSemExt(h.video?.nome)}</b>
            <span>${plural(h.frames, 'frame', 'frames')}${h.takes ? ` · ${plural(h.takes, 'take', 'takes')}` : ''}${h.posts ? ` · ${plural(h.posts, 'post', 'posts')}` : ''}</span>
            <span class="sub">${relTime(h.criado)}${h.drive ? html` · <${Icon} name="cloud" size=${11} /> no Drive` : ''}</span>
          </span>
        </a>`,
      )}
    </div>
  </section>`
}

function Inicio() {
  const job = useStore((s) => s.frames)
  const [hist, setHist] = useState(null)
  const esperando = useRef(null)
  const carregar = () => api.get('/api/frames').then((r) => setHist(r.historico || []), () => setHist([]))
  useEffect(() => {
    carregar()
  }, [])
  useEffect(() => {
    if (!job) return
    if (job.status !== 'running') carregar()
    // O trabalho que começou daqui terminou: abre o resultado.
    if (job.status === 'done' && esperando.current === job.jobId && job.manifestoId) navigate(`frames/${job.manifestoId}`)
  }, [job?.status, job?.jobId])
  return html`<div class="page page-frames">
    <header class="page-head">
      <div>
        <h1>Frames</h1>
        <p class="page-lead">Do filme pronto aos posts: frames em alta, takes e artes para as redes.</p>
      </div>
    </header>
    <${Andamento} job=${job} />
    ${job?.status === 'running' ? null : html`<${Novo} onComecou=${(id) => (esperando.current = id)} />`}
    <${Historico} lista=${hist} />
  </div>`
}

// ─────────── o trabalho ───────────

function useTrabalho(id) {
  const [m, setM] = useState(null)
  const [erro, setErro] = useState(null)
  const job = useStore((s) => s.frames)
  const carregar = () =>
    api.get(`/api/frames/${enc(id)}`).then(
      (r) => {
        setM(r.trabalho)
        setErro(null)
      },
      (e) => setErro(e.message),
    )
  useEffect(() => {
    carregar()
  }, [id])
  // Enquanto os takes saem, recarrega a cada fase.
  useEffect(() => {
    if (job?.manifestoId === id) carregar()
  }, [job?.manifestoId === id && job?.status, job?.manifestoId === id && job?.texto])
  return { m, setM, erro, carregar }
}

function Lightbox({ m, lista, i, onI, onClose }) {
  const f = lista[i]
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') onI(Math.min(lista.length - 1, i + 1))
      else if (e.key === 'ArrowLeft') onI(Math.max(0, i - 1))
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [i, lista.length])
  if (!f) return null
  return html`<div class="fr-luz" role="dialog" aria-modal="true" aria-label=${f.id} onClick=${onClose}>
    <img src=${arquivoUrl(m.id, { alta: f.id })} alt="" onClick=${(e) => e.stopPropagation()} />
    <div class="fr-luz-info" onClick=${(e) => e.stopPropagation()}>
      <b>${f.id}</b><span>Cena ${String(f.cena).padStart(2, '0')} · ${tc(f.tc)}</span>
      <${Button} size="sm" variant="ghost" icon="reveal" onClick=${() => revealPath(juntar(m.pasta, f.arquivo))}>${revealLabel()}</${Button}>
    </div>
    <${IconButton} icon="x" label="Fechar" class="fr-luz-x" onClick=${onClose} />
    ${i > 0 ? html`<button type="button" class="fr-luz-nav is-esq" aria-label="Anterior" onClick=${(e) => (e.stopPropagation(), onI(i - 1))}><${Icon} name="chevron-left" size=${22} /></button>` : null}
    ${i < lista.length - 1 ? html`<button type="button" class="fr-luz-nav is-dir" aria-label="Próximo" onClick=${(e) => (e.stopPropagation(), onI(i + 1))}><${Icon} name="chevron-right" size=${22} /></button>` : null}
  </div>`
}

function FrameCard({ m, f, ordem, onSel, onAbrir, onAcao, busy }) {
  const ar = m.video.largura && m.video.altura ? `${m.video.largura} / ${m.video.altura}` : '16 / 9'
  return html`<div class=${cx('fr-frame', ordem && 'is-sel', f.descartado && 'is-fora', busy && 'is-busy')}>
    <button type="button" class="fr-frame-img" style=${`aspect-ratio:${ar}`} onClick=${() => (f.descartado ? null : onAbrir())} aria-label=${`Abrir ${f.id}`}>
      <img src=${arquivoUrl(m.id, { mini: f.id })} alt="" loading="lazy" />
      ${busy ? html`<span class="fr-frame-busy"><${Spinner} size=${18} /></span>` : null}
    </button>
    ${f.descartado
      ? html`<div class="fr-frame-fora"><span>Descartado</span><${Button} size="sm" onClick=${() => onAcao('voltar')}>Voltar</${Button}></div>`
      : html`<button type="button" class="fr-frame-sel" aria-pressed=${ordem ? 'true' : 'false'} aria-label=${ordem ? `Tirar ${f.id} do post` : `Usar ${f.id} no post`} title="Usar no post" onClick=${onSel}>${ordem || html`<${Icon} name="plus" size=${13} />`}</button>
          <div class="fr-frame-acoes">
            <button type="button" title="Outro frame desta cena" aria-label="Outro frame" onClick=${() => onAcao('trocar')}><${Icon} name="refresh" size=${14} /></button>
            <button type="button" title="Descartar" aria-label="Descartar" onClick=${() => onAcao('descartar')}><${Icon} name="trash" size=${14} /></button>
          </div>`}
    <span class="fr-frame-tc">${tc(f.tc)}${f.manual ? ' · no ponto' : ''}</span>
  </div>`
}

function AbaFrames({ m, setM, sel, setSel }) {
  const [verFora, setVerFora] = useState(false)
  const [luz, setLuz] = useState(null)
  const [ocupado, setOcupado] = useState(() => new Set())
  const ativos = m.frames.filter((f) => !f.descartado)
  const fora = m.frames.filter((f) => f.descartado)
  const marcar = (k, on) =>
    setOcupado((s) => {
      const n = new Set(s)
      on ? n.add(k) : n.delete(k)
      return n
    })
  const acao = async (f, a) => {
    marcar(f.id, true)
    const r =
      a === 'trocar'
        ? await attempt(api.post(`/api/frames/${enc(m.id)}/mais`, { trocar: f.id }))
        : await attempt(api.post(`/api/frames/${enc(m.id)}/descartar`, { item: f.id, descartado: a !== 'voltar' }))
    marcar(f.id, false)
    if (r?.trabalho) {
      setM(r.trabalho)
      if (a !== 'voltar') setSel((s) => s.filter((x) => x !== f.id))
    }
  }
  const maisUm = async (c) => {
    marcar(`c${c.n}`, true)
    const r = await attempt(api.post(`/api/frames/${enc(m.id)}/mais`, { cena: c.n }))
    marcar(`c${c.n}`, false)
    if (r?.trabalho) setM(r.trabalho)
  }
  const nomear = async (c) => {
    const nome = await promptDialog({ title: `Nome da cena ${String(c.n).padStart(2, '0')}`, label: 'Vira o nome da pasta', placeholder: c.tags.join(', '), initial: c.nome || '', confirmLabel: 'Salvar' })
    if (nome == null) return
    const r = await attempt(api.post(`/api/frames/${enc(m.id)}/cena`, { n: c.n, nome }))
    if (r?.trabalho) setM(r.trabalho)
  }
  const noPonto = async () => {
    const v = await promptDialog({ title: 'Frame num ponto exato', label: 'Tempo no vídeo (ex.: 1:23.5 ou 83.5)', placeholder: '0:00.0', confirmLabel: 'Tirar o frame' })
    if (!v) return
    const p = String(v).trim().replace(',', '.').split(':').map(Number)
    const t = p.reduce((s, x) => s * 60 + x, 0)
    if (!Number.isFinite(t)) return toast('error', 'Não entendi esse tempo.')
    const r = await attempt(api.post(`/api/frames/${enc(m.id)}/no-ponto`, { t }))
    if (r?.trabalho) setM(r.trabalho)
  }
  const alternar = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return html`<div class="fr-aba">
    <div class="fr-aba-barra">
      <span class="fr-aba-txt">${m.descartes ? html`Fora da escolha: <b>${m.descartes.escuro_ou_estourado}</b> escuros ou estourados, <b>${m.descartes.desfocado_ou_tremido}</b> desfocados ou tremidos, <b>${m.descartes.transicao}</b> em corte ou transição.` : null}</span>
      <${Button} size="sm" icon="plus" onClick=${noPonto}>Frame num ponto</${Button}>
    </div>
    ${m.cenas.map((c) => {
      const fs = m.frames.filter((f) => f.cena === c.n && (!f.descartado || verFora))
      if (!fs.length) return null
      return html`<section key=${c.n} class="fr-cena">
        <header class="fr-cena-head">
          <span class="fr-cena-n">${String(c.n).padStart(2, '0')}</span>
          <div class="fr-cena-txt">
            <button type="button" class="fr-cena-nome" onClick=${() => nomear(c)} title="Dar nome à cena (vira a pasta)">${c.nome || 'Cena sem nome'} <${Icon} name="pencil" size=${12} /></button>
            <span class="fr-cena-tags">${c.tags.map((t) => html`<span class="fr-tag">${t}</span>`)}<span class="sub">${clipTime(c.ini)}–${clipTime(c.fim)}</span></span>
          </div>
          <${Button} size="sm" variant="ghost" icon="plus" loading=${ocupado.has(`c${c.n}`)} disabled=${!c.sobram} onClick=${() => maisUm(c)}>Mais um</${Button}>
        </header>
        <div class="fr-grade">
          ${fs.map((f) => html`<${FrameCard} key=${f.id} m=${m} f=${f} ordem=${sel.indexOf(f.id) + 1 || 0} busy=${ocupado.has(f.id)} onSel=${() => alternar(f.id)} onAbrir=${() => setLuz(ativos.indexOf(f))} onAcao=${(a) => acao(f, a)} />`)}
        </div>
      </section>`
    })}
    ${fora.length
      ? html`<button type="button" class="fr-ver-fora" onClick=${() => setVerFora(!verFora)}>${verFora ? 'Esconder os descartados' : `Ver os descartados (${fora.length})`}</button>`
      : null}
    ${luz != null && luz >= 0 ? html`<${Lightbox} m=${m} lista=${ativos} i=${luz} onI=${setLuz} onClose=${() => setLuz(null)} />` : null}
  </div>`
}

function TakeCard({ m, t, onAcao, busy }) {
  const ref = useRef(null)
  const toca = t.codec !== 'prores'
  const ar = t.formato === 'original' ? (m.video.largura && m.video.altura ? `${m.video.largura} / ${m.video.altura}` : '16 / 9') : t.formato.replace(':', ' / ')
  return html`<div class=${cx('fr-take', t.descartado && 'is-fora')}>
    <div
      class="fr-take-vid"
      style=${`aspect-ratio:${ar}`}
      onMouseEnter=${() => toca && ref.current?.play().catch(() => {})}
      onMouseLeave=${() => {
        if (!ref.current) return
        ref.current.pause()
        ref.current.currentTime = 0
      }}
    >
      ${toca
        ? html`<video ref=${ref} src=${arquivoUrl(m.id, { p: t.arquivo })} poster=${arquivoUrl(m.id, { mini: t.id })} muted loop playsinline preload="none"></video>`
        : html`<img src=${arquivoUrl(m.id, { mini: t.id })} alt="" />`}
      <span class="fr-take-tag">${t.codec === 'prores' ? 'ProRes 422 HQ' : t.formato === 'original' ? 'H.264' : t.formato}</span>
      ${busy ? html`<span class="fr-frame-busy"><${Spinner} size=${18} /></span>` : null}
    </div>
    <div class="fr-take-meta">
      <span><b>${t.id}</b> · Cena ${String(t.cena).padStart(2, '0')} · ${t.dur.toFixed(1).replace('.', ',')} s</span>
      <span class="sub">${tc(t.tc)}</span>
    </div>
    ${t.descartado
      ? html`<div class="fr-take-acoes"><${Button} size="sm" onClick=${() => onAcao({ voltar: true })}>Voltar</${Button}></div>`
      : html`<div class="fr-take-acoes">
          <span class="sub">Também em</span>
          ${['9:16', '4:5', '1:1', 'original'].filter((f) => f !== t.formato).map((f) => html`<button type="button" class="fr-chip" onClick=${() => onAcao({ formato: f })}>${f === 'original' ? 'Original' : f}</button>`)}
          <button type="button" class="fr-chip" onClick=${() => onAcao({ codec: t.codec === 'prores' ? 'h264' : 'prores' })}>${t.codec === 'prores' ? 'H.264' : 'ProRes'}</button>
          <span class="fr-take-mais">
            <${IconButton} icon="reveal" label=${revealLabel()} size=${14} onClick=${() => revealPath(juntar(m.pasta, t.arquivo))} />
            <${IconButton} icon="trash" label="Descartar" size=${14} onClick=${() => onAcao({ descartar: true })} />
          </span>
        </div>`}
  </div>`
}

function AbaTakes({ m, setM }) {
  const [ocupado, setOcupado] = useState(null)
  const acao = async (t, o) => {
    setOcupado(t.id)
    const r =
      o.descartar || o.voltar
        ? await attempt(api.post(`/api/frames/${enc(m.id)}/descartar`, { item: t.id, descartado: !!o.descartar }))
        : await attempt(api.post(`/api/frames/${enc(m.id)}/take`, { take: t.id, ...o }))
    setOcupado(null)
    if (r?.trabalho) {
      setM(r.trabalho)
      if (!o.descartar && !o.voltar) toast('success', 'Take pronto.')
    }
  }
  const lista = m.takes.filter((t) => !t.descartado).concat(m.takes.filter((t) => t.descartado))
  if (!m.takes.length)
    return html`<${EmptyState} compact art=${html`<${Icon} name="film" size=${32} strokeWidth=${1.2} />`} title="Sem takes neste trabalho">Ligue os takes no próximo vídeo para ganhar os melhores trechos de cada cena.</${EmptyState}>`
  return html`<div class="fr-aba">
    <div class="fr-aba-barra"><span class="fr-aba-txt">Passe o cursor para ver. Cada take é o trecho mais firme e bem exposto da cena, longe dos cortes.</span></div>
    <div class="fr-takes">${lista.map((t) => html`<${TakeCard} key=${t.id} m=${m} t=${t} busy=${ocupado === t.id} onAcao=${(o) => acao(t, o)} />`)}</div>
  </div>`
}

// ── posts

const imagens = new Map() // url → Promise<HTMLImageElement>
function carregarImagem(url) {
  if (!imagens.has(url))
    imagens.set(
      url,
      new Promise((ok, falha) => {
        const img = new Image()
        img.decoding = 'async'
        img.onload = () => ok(img)
        img.onerror = () => {
          imagens.delete(url)
          falha(new Error('imagem'))
        }
        img.src = url
      }),
    )
  return imagens.get(url)
}

/** Sem seleção: os melhores frames espalhados (um por cena, depois os de nota mais alta). */
function escolhaAutomatica(m, n, salto = 0) {
  const ativos = m.frames.filter((f) => !f.descartado).sort((a, b) => b.nota - a.nota)
  const porCena = []
  const vistos = new Set()
  for (const f of ativos) if (!vistos.has(f.cena)) vistos.add(f.cena) && porCena.push(f)
  const resto = ativos.filter((f) => !porCena.includes(f))
  const ordem = porCena.concat(resto)
  const out = []
  for (let i = 0; i < Math.min(n, ordem.length); i++) out.push(ordem[(i + salto) % ordem.length])
  return out.sort((a, b) => a.t - b.t)
}

// Formatos que podem ir em tela cheia (os frames ocupam o post inteiro, sem bordas do fundo).
const TELA_CHEIA = new Set(['triade', 'grade'])

function AbaPosts({ m, setM, sel, irParaFrames }) {
  const [p, setP] = useState(() => ({ layout: 'triade', n: 3, proporcao: '4:5', fundo: 'preto', respiro: true, logo: !!m.ajustes.logo, titulo: nomeSemExt(m.video.nome), sub: '', slides: 2, ...storage.get('frames.post', {}) }))
  const [salto, setSalto] = useState(0)
  const [salvando, setSalvando] = useState(false)
  const [falta, setFalta] = useState(false)
  const [enq, setEnq] = useState({}) // id do frame → { x, y, zoom }: vale em qualquer formato
  const [ativo, setAtivo] = useState(null) // índice do frame sendo enquadrado
  const arrasto = useRef(null)
  const tamanhos = useRef(new Map()) // id do frame → [largura, altura] da imagem em alta
  const canvas = useRef(null)
  const L = layoutPorId(p.layout)
  const n = L.quantos.includes(p.n) ? p.n : L.padrao
  const muda = (o) =>
    setP((x) => {
      const y = { ...x, ...o }
      storage.set('frames.post', { layout: y.layout, n: y.n, proporcao: y.proporcao, fundo: y.fundo, respiro: y.respiro, slides: y.slides, cheio: y.cheio })
      return y
    })
  const escolhidos = useMemo(() => {
    const porId = new Map(m.frames.map((f) => [f.id, f]))
    const s = sel.map((id) => porId.get(id)).filter((f) => f && !f.descartado)
    if (s.length >= n) return s.slice(0, n)
    const auto = escolhaAutomatica(m, n + s.length, salto).filter((f) => !s.includes(f))
    return s.concat(auto).slice(0, n)
  }, [m, sel, n, salto])
  const desenhar = async (cv, escala, destaque = null) => {
    const imgs = await Promise.all(escolhidos.map((f) => carregarImagem(arquivoUrl(m.id, { alta: f.id }))))
    imgs.forEach((img, i) => tamanhos.current.set(escolhidos[i].id, [img.naturalWidth, img.naturalHeight]))
    const logo = p.logo && m.ajustes.logo ? await carregarImagem(logoUrl(m.ajustes.logo.path)).catch(() => null) : null
    return desenharPost(cv, {
      layout: p.layout,
      proporcao: p.proporcao,
      escala,
      imagens: imgs,
      fundo: p.fundo,
      respiro: p.respiro,
      textos: { titulo: p.titulo, sub: p.sub, legendas: p.layout === 'polaroid' ? [p.titulo, p.sub] : undefined },
      timecodes: escolhidos.map((f) => f.tc),
      logo,
      logoAjustes: m.ajustes.logo,
      slides: p.slides,
      cheio: TELA_CHEIA.has(p.layout) && p.cheio,
      enquadres: escolhidos.map((f) => enq[f.id]),
      destaque,
    })
  }
  const emEdicao = ativo != null && ativo <= (p.layout === 'carrossel' ? 0 : escolhidos.length - 1) ? ativo : null
  useEffect(() => {
    let vivo = true
    const cv = document.createElement('canvas')
    desenhar(cv, 0.5, emEdicao)
      .then(() => {
        if (!vivo || !canvas.current) return
        const alvo = canvas.current
        alvo.width = cv.width
        alvo.height = cv.height
        alvo.getContext('2d').drawImage(cv, 0, 0)
        setFalta(false)
      })
      .catch(() => vivo && setFalta(true))
    return () => {
      vivo = false
    }
  }, [escolhidos, p, enq, emEdicao])

  // ── enquadrar: clicar escolhe o frame; arrastar move; a roda do mouse (ou a barra) aproxima ──
  const ponto = (e) => {
    const c = canvas.current
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }
  }
  const noPonto = (pt) => frameNoPonto(p.layout, { proporcao: p.proporcao, escala: 0.5, n: escolhidos.length, respiro: p.respiro, slides: p.slides, cheio: TELA_CHEIA.has(p.layout) && p.cheio }, pt.x, pt.y)
  const mudaEnq = (i, fn) => {
    const f = escolhidos[i]
    if (f) setEnq((x) => ({ ...x, [f.id]: fn(x[f.id], f) }))
  }
  const desce = (e) => {
    const pt = ponto(e)
    const alvo = noPonto(pt)
    arrasto.current = { alvo, ultimo: pt, andou: 0 }
    if (alvo) {
      setAtivo(alvo.i)
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
  }
  const move = (e) => {
    const a = arrasto.current
    if (!a?.alvo) return
    const pt = ponto(e)
    const dx = pt.x - a.ultimo.x
    const dy = pt.y - a.ultimo.y
    a.ultimo = pt
    a.andou += Math.abs(dx) + Math.abs(dy)
    const tam = tamanhos.current.get(escolhidos[a.alvo.i]?.id)
    if (tam) mudaEnq(a.alvo.i, (x) => moverEnquadre(x, dx, dy, tam[0], tam[1], a.alvo.caixa))
  }
  const sobe = () => {
    const a = arrasto.current
    arrasto.current = null
    if (a && !a.alvo && a.andou < 4) setAtivo(null)
  }
  const roda = (e) => {
    const alvo = noPonto(ponto(e))
    if (!alvo) return
    e.preventDefault()
    setAtivo(alvo.i)
    mudaEnq(alvo.i, (x) => {
      const q = enquadreDe(x)
      return { ...q, zoom: Math.min(ZOOM_MAX, Math.max(1, q.zoom * Math.exp(-e.deltaY * 0.002))) }
    })
  }
  useEffect(() => {
    // A roda precisa de passive: false para não rolar a página enquanto aproxima.
    const c = canvas.current
    if (!c) return
    c.addEventListener('wheel', roda, { passive: false })
    return () => c.removeEventListener('wheel', roda)
  })
  const atual = emEdicao != null ? enquadreDe(enq[escolhidos[emEdicao]?.id]) : null

  const salvar = async () => {
    setSalvando(true)
    try {
      const cv = await desenhar(document.createElement('canvas'), 2)
      const partes = p.layout === 'carrossel' ? fatiar(cv, p.slides) : [cv]
      let ultimo = null
      for (const [i, c] of partes.entries()) {
        const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.95))
        const tipo = p.layout === 'carrossel' ? `${L.nome} ${i + 1} de ${partes.length}` : `${L.nome}${L.quantos.length > 1 ? ` ${n}` : ''}`
        const res = await fetch(withQuery(`/api/frames/${enc(m.id)}/post`, { tipo, proporcao: p.proporcao }), { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob })
        const d = await res.json().catch(() => null)
        if (!res.ok || !d?.ok) throw new Error(d?.error || 'Não consegui salvar o post.')
        ultimo = d
      }
      if (ultimo?.trabalho) setM(ultimo.trabalho)
      toast('success', partes.length > 1 ? `${partes.length} slides salvos em Posts.` : 'Post salvo em Posts.')
    } catch (err) {
      toast('error', err?.message || 'Não consegui salvar o post.')
    }
    setSalvando(false)
  }
  const apagar = async (arquivo) => {
    const r = await attempt(api.post(`/api/frames/${enc(m.id)}/post/apagar`, { arquivo }))
    if (r?.trabalho) setM(r.trabalho)
  }
  const ar = { '4:5': '4 / 5', '1:1': '1 / 1', '9:16': '9 / 16' }[p.proporcao]

  return html`<div class="fr-aba">
    <div class="fr-posts">
      <div class="fr-posts-palco">
        <div class=${cx('fr-posts-tela', p.layout === 'carrossel' && 'is-carrossel')} style=${p.layout === 'carrossel' ? '' : `aspect-ratio:${ar}`}>
          <canvas ref=${canvas} class=${cx(emEdicao != null && 'is-enquadrando')} aria-label="Prévia do post. Clique num frame para enquadrar." onPointerDown=${desce} onPointerMove=${move} onPointerUp=${sobe} onPointerCancel=${sobe}></canvas>
          ${falta ? html`<span class="fr-posts-erro">Não consegui abrir um dos frames.</span>` : null}
          ${p.layout === 'carrossel' ? html`<span class="fr-posts-cortes" style=${`--n:${p.slides}`}></span>` : null}
        </div>
        ${atual
          ? html`<div class="fr-enq" role="group" aria-label=${`Enquadrar o frame ${emEdicao + 1}`}>
              <span class="fr-enq-t"><b>Frame ${emEdicao + 1}</b><small>Arraste; a roda do mouse aproxima.</small></span>
              <label class="fr-enq-zoom"><${Icon} name="zoom" size=${15} />
                <input type="range" aria-label="Zoom" min="1" max=${ZOOM_MAX} step="0.01" value=${atual.zoom} onInput=${(e) => mudaEnq(emEdicao, (x) => ({ ...enquadreDe(x), zoom: Number(e.currentTarget.value) }))} />
                <output>${atual.zoom.toFixed(1).replace('.', ',')}×</output>
              </label>
              <${Button} size="sm" variant="ghost" disabled=${!enq[escolhidos[emEdicao]?.id]} onClick=${() => mudaEnq(emEdicao, () => undefined)}>Centralizar</${Button}>
              <${Button} size="sm" variant="secondary" onClick=${() => setAtivo(null)}>Pronto</${Button}>
            </div>`
          : html`<p class="fr-enq-dica"><${Icon} name="crop" size=${13} />Clique num frame para mudar o enquadramento.</p>`}
        <div class="fr-posts-usados">
          ${escolhidos.map((f) => html`<img key=${f.id} src=${arquivoUrl(m.id, { mini: f.id })} alt=${f.id} title=${`${f.id} · ${tc(f.tc)}`} />`)}
          <span class="fr-posts-usados-txt">${sel.length ? `${sel.length} escolhido${sel.length > 1 ? 's' : ''} na aba Frames` : 'Escolha automática'}</span>
          ${sel.length ? null : html`<${Button} size="sm" variant="ghost" icon="refresh" onClick=${() => setSalto((s) => s + n)}>Outros</${Button}>`}
          <${Button} size="sm" variant="ghost" onClick=${irParaFrames}>Escolher frames</${Button}>
        </div>
      </div>
      <aside class="fr-posts-lado">
        <div class="fr-layouts" role="radiogroup" aria-label="Formato do post">
          ${LAYOUTS.map(
            (l) => html`<button type="button" role="radio" aria-checked=${p.layout === l.id ? 'true' : 'false'} class=${cx('fr-layout', p.layout === l.id && 'is-on')} onClick=${() => muda({ layout: l.id, n: l.padrao })}>
              <span class=${cx('fr-layout-ic', `is-${l.id}`)} aria-hidden="true"><i></i><i></i><i></i></span>
              <b>${l.nome}</b><span>${l.dica}</span>
            </button>`,
          )}
        </div>
        <div class="fr-linhas">
          ${L.quantos.length > 1
            ? html`<div class="fr-linha"><span class="fr-rot">Frames</span><${Segmented} size="sm" label="Quantos frames" value=${n} onChange=${(v) => muda({ n: v })} options=${L.quantos.map((q) => ({ value: q, label: L.id === 'grade' ? (q === 4 ? '2×2' : '3×3') : String(q) }))} /></div>`
            : null}
          ${L.slides
            ? html`<div class="fr-linha"><span class="fr-rot">Slides</span><${Segmented} size="sm" label="Quantos slides" value=${p.slides} onChange=${(v) => muda({ slides: v })} options=${L.slides.map((q) => ({ value: q, label: String(q) }))} /></div>`
            : null}
          <div class="fr-linha"><span class="fr-rot">Tamanho</span><${Segmented} size="sm" label="Proporção" value=${p.proporcao} onChange=${(v) => muda({ proporcao: v })} options=${[{ value: '4:5', label: '4:5', title: 'Feed' }, { value: '1:1', label: '1:1' }, { value: '9:16', label: '9:16', title: 'Stories' }]} /></div>
          <div class="fr-linha"><span class="fr-rot">Fundo</span><${Segmented} size="sm" label="Fundo" value=${p.fundo} onChange=${(v) => muda({ fundo: v })} options=${Object.keys(FUNDOS).map((f) => ({ value: f, label: f[0].toUpperCase() + f.slice(1) }))} /></div>
          ${TELA_CHEIA.has(p.layout) ? html`<div class="fr-linha"><span class="fr-rot">Tela cheia<small>sem bordas do fundo</small></span><${Switch} checked=${!!p.cheio} label="Tela cheia, sem bordas" onChange=${(v) => muda({ cheio: v })} /></div>` : null}
          ${['triade', 'box', 'cinema', 'contato', 'polaroid'].includes(p.layout) && !(p.layout === 'triade' && p.cheio)
            ? html`<label class="fr-campo"><span>${p.layout === 'polaroid' ? 'Legenda' : 'Título'}</span><input class="input" value=${p.titulo} maxlength="60" onInput=${(e) => muda({ titulo: e.currentTarget.value })} /></label>`
            : null}
          ${['box', 'cinema'].includes(p.layout) || (p.layout === 'polaroid' && n > 1)
            ? html`<label class="fr-campo"><span>${p.layout === 'polaroid' ? 'Segunda legenda' : 'Linha de baixo'}</span><input class="input" value=${p.sub} maxlength="80" placeholder=${p.layout === 'cinema' ? 'Direção · Ano' : p.layout === 'box' ? 'Timecode' : ''} onInput=${(e) => muda({ sub: e.currentTarget.value })} /></label>`
            : null}
          ${m.ajustes.logo ? html`<div class="fr-linha"><span class="fr-rot">Logomarca</span><${Switch} checked=${p.logo} label="Logomarca no post" onChange=${(v) => muda({ logo: v })} /></div>` : null}
        </div>
        <${Button} variant="primary" icon="download" loading=${salvando} disabled=${!escolhidos.length || falta} onClick=${salvar}>Salvar em alta${p.layout === 'carrossel' ? ` (${p.slides} slides)` : ''}</${Button}>
        <p class="fr-posts-nota">${p.layout === 'carrossel' ? `${p.slides} JPEGs de 2160 px` : 'JPEG de 2160 px'}, na pasta Posts. Sobe para o Drive junto com o resto.</p>
      </aside>
    </div>
    ${m.posts.length
      ? html`<section class="fr-salvos">
          <h3 class="fr-sec-titulo">Posts salvos</h3>
          <div class="fr-salvos-grade">
            ${m.posts.map(
              (s) => html`<div class="fr-salvo" key=${s.arquivo}>
                <img src=${arquivoUrl(m.id, { p: s.arquivo })} alt="" loading="lazy" />
                <div class="fr-salvo-meta"><span>${s.tipo} · ${s.proporcao}</span>
                  <span>
                    <${IconButton} icon="reveal" size=${14} label=${revealLabel()} onClick=${() => revealPath(juntar(m.pasta, s.arquivo))} />
                    <${IconButton} icon="trash" size=${14} label="Apagar" onClick=${() => apagar(s.arquivo)} />
                  </span>
                </div>
              </div>`,
            )}
          </div>
        </section>`
      : null}
  </div>`
}

function Trabalho({ id }) {
  const { m, setM, erro } = useTrabalho(id)
  const job = useStore((s) => s.frames)
  const accounts = useStore((s) => s.accounts)
  const activeAccountId = useStore((s) => s.activeAccountId)
  const home = useStore((s) => s.app?.home)
  const [aba, setAba] = useState('frames')
  const [sel, setSel] = useState([])
  const [subindo, setSubindo] = useState(false)
  const rodando = job?.status === 'running' && job.manifestoId === id

  if (erro && !m)
    return html`<div class="page page-frames"><div class="table-msg is-error"><${Icon} name="warning" size=${18} /><span>${erro}</span><${Button} size="sm" onClick=${() => navigate('frames')}>Voltar</${Button}></div></div>`
  if (!m) return html`<div class="page page-frames"><div class="table-msg"><${Spinner} size=${16} /></div></div>`

  const ativos = m.frames.filter((f) => !f.descartado)
  const takes = m.takes.filter((t) => !t.descartado)

  const subir = async (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    let para = null
    if (m.video.origem === 'drive') {
      const c = await openModal('choice', {
        title: 'Subir a pasta para o Drive',
        anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        options: [
          { value: 'junto', icon: 'upload', label: 'Ao lado do vídeo', hint: 'Na mesma pasta do original' },
          { value: 'escolher', icon: 'cloud', label: 'Escolher pasta…', hint: 'Qualquer pasta dos seus Drives' },
        ],
      })
      if (!c) return
      para = c === 'junto' ? 'junto' : null
    }
    if (!para) {
      const accountId = m.video.accountId || activeAccountId || accounts[0]?.id
      if (!accountId) return toast('error', 'Conecte um Drive primeiro.')
      const r = await pickDriveFolder({ accountId, title: 'Subir a pasta para…', destinos: true })
      if (!r) return
      para = { accountId, folderId: r.id, driveId: r.driveId || null, name: r.name }
    }
    setSubindo(true)
    const r = await attempt(api.post(`/api/frames/${enc(m.id)}/subir`, { para }))
    setSubindo(false)
    if (r?.trabalho) {
      setM(r.trabalho)
      toast('success', `Subindo ${plural(r.count, 'arquivo', 'arquivos')} para o Drive.`, { action: { label: 'Ver', href: '#/transferencias' } })
    }
  }
  const esquecer = async () => {
    const ok = await openModal('confirm', { title: 'Tirar da lista?', message: 'Os arquivos continuam na pasta do computador (e no Drive, se subiram). Só some daqui.', confirmLabel: 'Tirar da lista' })
    if (!ok) return
    if (await attempt(api.del(`/api/frames/${enc(m.id)}`))) navigate('frames')
  }

  return html`<div class="page page-frames">
    <nav class="ref-crumbs" aria-label="Caminho"><a href="#/frames">Frames</a><${Icon} name="chevron-right" size=${13} /><span>${nomeSemExt(m.video.nome)}</span></nav>
    <header class="page-head fr-head">
      <div>
        <h1>${nomeSemExt(m.video.nome)}</h1>
        <p class="page-lead">
          ${plural(m.cenas.length, 'cena', 'cenas')} · ${plural(ativos.length, 'frame', 'frames')} · ${plural(takes.length, 'take', 'takes')}${m.posts.length ? ` · ${plural(m.posts.length, 'post', 'posts')}` : ''}
          ${m.drive ? html` · <span class="fr-nuvem"><${Icon} name="cloud" size=${13} /> subiu ${relTime(m.drive.em)}${m.drive.name ? ` para ${m.drive.name}` : ''}</span>` : null}
        </p>
      </div>
      <div class="page-head-actions">
        <${Button} icon="reveal" onClick=${() => revealPath(m.pasta)} title=${shortPath(m.pasta, home)}>${revealLabel()}</${Button}>
        <${Button} variant="primary" icon="upload" loading=${subindo} disabled=${rodando} onClick=${subir}>Subir pro Drive</${Button}>
        <${IconButton} icon="trash" label="Tirar da lista" onClick=${esquecer} />
      </div>
    </header>
    ${rodando ? html`<${Andamento} job=${job} />` : null}
    <div class="fr-abas">
      <${Segmented}
        label="Ver"
        value=${aba}
        onChange=${setAba}
        options=${[
          { value: 'frames', label: 'Frames', count: ativos.length },
          { value: 'takes', label: 'Takes', count: takes.length },
          { value: 'posts', label: 'Posts', count: m.posts.length },
        ]}
      />
      ${sel.length && aba === 'frames'
        ? html`<div class="fr-sel">
            <span>${plural(sel.length, 'frame escolhido', 'frames escolhidos')}</span>
            <${Button} size="sm" variant="ghost" onClick=${() => setSel([])}>Limpar</${Button}>
            <${Button} size="sm" variant="primary" icon="arrow-right" onClick=${() => setAba('posts')}>Montar post</${Button}>
          </div>`
        : null}
    </div>
    ${aba === 'frames'
      ? html`<${AbaFrames} m=${m} setM=${setM} sel=${sel} setSel=${setSel} />`
      : aba === 'takes'
        ? html`<${AbaTakes} m=${m} setM=${setM} />`
        : html`<${AbaPosts} key=${m.id} m=${m} setM=${setM} sel=${sel} irParaFrames=${() => setAba('frames')} />`}
  </div>`
}

export function FramesScreen({ route }) {
  const id = route.parts[1] || null
  return id ? html`<${Trabalho} key=${id} id=${id} />` : html`<${Inicio} />`
}
