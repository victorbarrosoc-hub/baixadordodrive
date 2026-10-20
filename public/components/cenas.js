// Aba Drive → "Procurar cenas" (docs/CENAS.md): a pessoa escreve o que quer ("noiva com o buquê", "DJ", "criança
// entrando na cerimônia") e o app mostra os trechos dos vídeos analisados, com a miniatura, o tempo e o quanto parece.
// Clicar abre a prévia já no ponto; "Salvar trecho" corta do original para Downloads/Cenas. Tudo no computador.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, getState } from '../lib/store.js'
import { api, attempt, withQuery } from '../lib/api.js'
import { cx } from '../lib/ui.js'
import { bytes } from '../lib/format.js'
import { toast } from '../lib/toasts.js'
import { revealLabel, revealPath } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Spinner } from './common.js'
import { PERFIS } from '../lib/cor-lut.js'

const EXEMPLOS = ['noiva com o buquê', 'DJ tocando', 'criança entrando na cerimônia', 'flor vermelha no altar', 'banda no palco', 'pista de dança cheia']
const tc = (s) => {
  const x = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(x / 3600)
  const m = Math.floor((x % 3600) / 60)
  const ss = String(x % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const miniUrl = (accountId, r) => withQuery('/api/cenas/mini', { accountId, fileId: r.fileId, i: r.i, k: getState().media?.key || '' })
const tom = (nota) => (nota >= 0.6 ? 'is-alta' : nota >= 0.35 ? 'is-media' : 'is-baixa')

/**
 * @param {{ accountId: string, folderId: string, folderNome: string, videosAqui: number, onAbrir: (item, t) => void, onFechar: () => void }} props
 */
export function CenasPainel({ accountId, folderId, folderNome, videosAqui, onAbrir, onFechar }) {
  const cenas = useStore((s) => s.cenas)
  const [texto, setTexto] = useState('')
  const [escopo, setEscopo] = useState('pasta') // 'pasta' | 'tudo'
  const [pasta, setPasta] = useState(null) // { videos: [...], total }
  const [res, setRes] = useState(null) // { resultados, videos, texto }
  const [buscando, setBuscando] = useState(false)
  const [salvando, setSalvando] = useState(null)
  const [todos, setTodos] = useState(false)
  const [perfil, setPerfil] = useState(() => {
    try {
      return localStorage.getItem('cenas.perfil') || 'auto'
    } catch {
      return 'auto'
    }
  })
  const mudaPerfil = (v) => {
    setPerfil(v)
    try {
      localStorage.setItem('cenas.perfil', v)
    } catch {}
  }
  const campo = useRef(null)
  const analisando = cenas?.analisando
  const fila = cenas?.fila || []
  const atual = fila.find((f) => f.fase === 'lendo')
  const naFila = fila.filter((f) => f.fase === 'na_fila').length
  const feitosAgora = fila.filter((f) => f.fase === 'pronto').length

  const carregarPasta = async () => {
    try {
      setPasta(await api.get(withQuery('/api/cenas/pasta', { accountId, folderId })))
    } catch {
      setPasta({ videos: [], total: 0 })
    }
  }
  useEffect(() => {
    setPasta(null)
    setRes(null)
    carregarPasta()
    campo.current?.focus()
  }, [accountId, folderId])
  // Um vídeo terminou de ser analisado: atualiza a contagem.
  useEffect(() => {
    if (feitosAgora) carregarPasta()
  }, [feitosAgora])

  const procurar = async (q = texto) => {
    const frase = q.trim()
    if (!frase) return
    setTexto(frase)
    setBuscando(true)
    const fileIds = escopo === 'pasta' ? (pasta?.videos || []).map((v) => v.fileId) : null
    const r = await attempt(api.post('/api/cenas/procurar', { accountId, texto: frase, fileIds: fileIds?.length ? fileIds : escopo === 'pasta' ? ['-'] : null }))
    setBuscando(false)
    if (r) {
      setRes({ ...r, texto: frase })
      setTodos(false)
    }
  }
  const analisar = async () => {
    const r = await attempt(api.post('/api/cenas/analisar', { accountId, folderId, perfil }))
    if (!r) return
    if (!r.total) toast('info', 'Não há vídeos nesta pasta.')
    else if (!r.novos) toast('success', `Os ${r.total} vídeos desta pasta já estão analisados.`)
    else toast('info', `${r.novos} ${r.novos === 1 ? 'vídeo entrou' : 'vídeos entraram'} na análise.`)
  }
  const salvar = async (r) => {
    setSalvando(`${r.fileId}:${r.i}`)
    const out = await attempt(api.post('/api/cenas/trecho', { accountId, fileId: r.fileId, ini: Math.max(0, r.ini - 1), fim: r.fim + 1 }))
    setSalvando(null)
    if (out?.caminho) toast('success', 'Trecho salvo em Downloads/Cenas.', { action: { label: revealLabel(), onClick: () => revealPath(out.caminho) } })
  }

  const analisados = pasta?.videos?.length || 0
  const modelo = cenas?.modelo
  const baixandoModelo = modelo?.baixando
  const pct = modelo?.total ? Math.round((modelo.recebido / modelo.total) * 100) : 0
  const indisponivel = cenas && cenas.disponivel === false
  const resultados = res?.resultados || []
  const porVideo = useMemo(() => new Set(resultados.map((r) => r.fileId)).size, [resultados])
  // Os que parecem de verdade (perto do melhor); o resto fica atrás de "Mostrar mais".
  const corte = resultados.length ? Math.max(0.2, resultados[0].nota - 0.25) : 1
  const fortes = resultados.filter((r, k) => k < 4 || r.nota >= corte)
  const visiveis = todos ? resultados : fortes

  return html`<section class="cn" aria-label="Procurar cenas">
    <div class="cn-topo">
      <div class="cn-titulo">
        <span class="cn-ic"><${Icon} name="sparkle" size=${18} /></span>
        <div><h2>Procurar cenas</h2><p>Escreva o que você quer achar nos vídeos. A análise roda neste computador.</p></div>
        <button type="button" class="icon-btn cn-x" onClick=${onFechar} aria-label="Fechar a busca por cena" title="Fechar"><${Icon} name="x" size=${16} /></button>
      </div>
      <form class="cn-busca" onSubmit=${(e) => (e.preventDefault(), procurar())}>
        <${Icon} name="search" size=${18} />
        <input ref=${campo} value=${texto} onInput=${(e) => setTexto(e.currentTarget.value)} placeholder="ex.: noiva com o buquê, DJ, flor vermelha no altar" aria-label="O que procurar nos vídeos" maxlength="200" disabled=${indisponivel} />
        <div class="cn-escopo" role="radiogroup" aria-label="Onde procurar">
          <button type="button" role="radio" aria-checked=${escopo === 'pasta' ? 'true' : 'false'} class=${cx(escopo === 'pasta' && 'is-on')} onClick=${() => setEscopo('pasta')}>Nesta pasta</button>
          <button type="button" role="radio" aria-checked=${escopo === 'tudo' ? 'true' : 'false'} class=${cx(escopo === 'tudo' && 'is-on')} onClick=${() => setEscopo('tudo')}>Em tudo</button>
        </div>
        <button type="submit" class="cn-ir" disabled=${!texto.trim() || buscando || indisponivel}>${buscando ? html`<${Spinner} size=${15} />` : 'Procurar'}</button>
      </form>
      <div class="cn-exemplos">${EXEMPLOS.map((x) => html`<button type="button" class="cn-ex" onClick=${() => procurar(x)} disabled=${indisponivel}>${x}</button>`)}</div>
    </div>

    ${indisponivel
      ? html`<div class="cn-aviso"><${Icon} name="info" size=${16} />A busca por cena precisa de um Mac com Apple Silicon (M1 ou mais novo) ou de um Windows.</div>`
      : html`<div class="cn-estado">
          <div class="cn-estado-txt">
            ${baixandoModelo
              ? html`<b>Baixando a IA da busca · ${pct}%</b><span>${bytes(modelo.recebido)} de ${bytes(modelo.total)}, uma vez só</span>`
              : atual
                ? html`<b>Analisando “${atual.nome}” · ${Math.round((atual.frac || 0) * 100)}%</b><span>${naFila ? `mais ${naFila} na fila` : 'último da fila'}</span>`
                : html`<b>${analisados} ${analisados === 1 ? 'vídeo analisado' : 'vídeos analisados'} ${folderNome ? `em “${folderNome}”` : 'aqui'}</b><span>${videosAqui > analisados ? `${videosAqui - analisados} ainda sem analisar nesta pasta` : 'Analise de novo quando subirem vídeos novos'}</span>`}
          </div>
          ${baixandoModelo || atual
            ? html`<div class="cn-barra"><span style=${`width:${baixandoModelo ? pct : Math.round((atual?.frac || 0) * 100)}%`}></span></div>`
            : null}
          ${analisando
            ? html`<${Button} size="sm" variant="ghost" onClick=${() => attempt(api.post('/api/cenas/parar', {}))}>Parar</${Button}>`
            : html`<div class="cn-analisar-grupo">
                <label class="cn-cor" title="Material em LOG vira Rec.709 antes da análise (a IA vê as cores certas, como a flor vermelha)">
                  <span>Cor</span>
                  <select value=${perfil} onChange=${(e) => mudaPerfil(e.currentTarget.value)} aria-label="Cor do material">
                    <option value="auto">Automático (detecta LOG)</option>
                    ${Object.entries(PERFIS).map(([k, p]) => html`<option value=${k}>${p.nome}</option>`)}
                  </select>
                </label>
                <button type="button" class="cn-analisar" onClick=${analisar}><${Icon} name="sparkle" size=${15} />Analisar os vídeos desta pasta</button>
              </div>`}
        </div>`}

    ${res
      ? resultados.length
        ? html`<div class="cn-res-head"><b>${fortes.length} ${fortes.length === 1 ? 'trecho' : 'trechos'}</b> para “${res.texto}” · em ${porVideo} de ${res.videos} ${res.videos === 1 ? 'vídeo' : 'vídeos'}</div>
            <div class="cn-grade">
              ${visiveis.map(
                (r, k) => html`<article class="cn-card" key=${`${r.fileId}:${r.i}`} style=${`--i:${Math.min(k, 20)}`}>
                  <button type="button" class="cn-thumb" onClick=${() => onAbrir(r.item, r.t)} title="Abrir no ponto">
                    <img src=${miniUrl(accountId, r)} alt="" loading="lazy" />
                    <span class="cn-tc">${tc(r.ini)} – ${tc(r.fim)}</span>
                    <span class=${cx('cn-nota', tom(r.nota))}><i style=${`width:${Math.round(r.nota * 100)}%`}></i></span>
                    <span class="cn-play"><${Icon} name="play" size=${16} /></span>
                  </button>
                  <div class="cn-meta">
                    <span class="cn-nome" title=${r.nome}>${r.nome}</span>
                    <span class="cn-sub">
                      ${r.pasta ? html`<span class="cn-pasta" title=${r.pasta}>${r.pasta}</span>` : null}
                      ${r.perfil && r.perfil !== 'rec709' ? html`<span class="cn-log" title=${`${PERFIS[r.perfil]?.nome || 'LOG'} → Rec.709`}>LOG → 709</span>` : null}
                    </span>
                  </div>
                  <div class="cn-acoes">
                    <button type="button" onClick=${() => salvar(r)} disabled=${salvando === `${r.fileId}:${r.i}`} title="Corta este trecho do original (sem perder qualidade) para Downloads/Cenas">
                      ${salvando === `${r.fileId}:${r.i}` ? html`<${Spinner} size=${13} />` : html`<${Icon} name="download" size=${14} />`}Salvar trecho
                    </button>
                    <button type="button" onClick=${() => navigator.clipboard?.writeText(`${r.nome} ${tc(r.ini)}`).then(() => toast('success', 'Copiado.'))} title="Copiar o nome e o tempo"><${Icon} name="copy" size=${14} /></button>
                  </div>
                </article>`,
              )}
            </div>
            ${!todos && resultados.length > fortes.length
              ? html`<button type="button" class="cn-mais" onClick=${() => setTodos(true)}>Mostrar mais ${resultados.length - fortes.length} parecidos</button>`
              : null}`
        : html`<div class="cn-vazio">${res.videos ? `Nada parecido com “${res.texto}” nos vídeos analisados.` : escopo === 'pasta' ? 'Nenhum vídeo desta pasta foi analisado ainda. Toque em “Analisar os vídeos desta pasta”.' : 'Nenhum vídeo analisado ainda.'}</div>`
      : null}
  </section>`
}
