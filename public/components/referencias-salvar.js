// "Salvar referência": escolher a coleção (ou criar uma), uma nota opcional e salvar. O mesmo painel serve à janela
// "Colar link" da tela de Referências e ao painel do navegador de referências.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { cx } from '../lib/ui.js'
import { FORMATOS, criarColecao, detectarLink, formatosPara, lembrarTambem, salvarImagem, salvarLink, ultimaColecao, ultimosTambem, urlCurta, useColecoes } from '../lib/referencias.js'
import { Icon } from './icons.js'
import { Button, Spinner } from './common.js'

/** Lista de coleções com "Nova coleção" no fim (rádios grandes, fáceis de clicar). */
export function SeletorColecao({ value, onChange, autoFocus }) {
  const { colecoes, loading, error, reload } = useColecoes()
  const [criando, setCriando] = useState(false)
  const [nome, setNome] = useState('')
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState(null)
  const input = useRef(null)

  useEffect(() => {
    if (criando) input.current?.focus()
  }, [criando])
  useEffect(() => {
    // Sem escolha ainda: a última usada, senão a primeira.
    if (value || !colecoes?.length) return
    const ultima = ultimaColecao()
    onChange((colecoes.find((c) => c.id === ultima) || colecoes[0]).id)
  }, [colecoes, value])
  useEffect(() => {
    if (colecoes && !colecoes.length && !criando) setCriando(true)
  }, [colecoes])

  const criar = async (e) => {
    e?.preventDefault()
    const n = nome.trim()
    if (!n || busy) return
    setBusy(true)
    setErro(null)
    try {
      const c = await criarColecao({ nome: n })
      onChange(c.id)
      setNome('')
      setCriando(false)
    } catch (err) {
      setErro(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!colecoes && loading) return html`<div class="ref-pick is-loading"><${Spinner} size=${16} /> <span class="sub">Carregando coleções…</span></div>`
  if (!colecoes && error)
    return html`<div class="ref-pick-error"><${Icon} name="warning" size=${16} /><span>${error}</span><${Button} size="sm" onClick=${reload}>Tentar de novo</${Button}></div>`

  return html`<div class="ref-pick" role="radiogroup" aria-label="Coleção">
    ${(colecoes || []).map(
      (c, i) => html`<button
        type="button"
        role="radio"
        aria-checked=${value === c.id ? 'true' : 'false'}
        class=${cx('ref-pick-item', value === c.id && 'is-on')}
        onClick=${() => onChange(c.id)}
        autoFocus=${autoFocus && i === 0}
      >
        <span class="ref-pick-dot" aria-hidden="true"></span>
        <span class="ref-pick-name">${c.nome}</span>
        ${value === c.id ? html`<${Icon} name="check" size=${15} />` : null}
      </button>`,
    )}
    ${criando
      ? html`<form class="ref-pick-new" onSubmit=${criar}>
          <input ref=${input} class="input" type="text" maxlength="80" placeholder="Nome da coleção" value=${nome} onInput=${(e) => setNome(e.currentTarget.value)} aria-label="Nome da nova coleção" onKeyDown=${(e) => e.key === 'Escape' && colecoes?.length && (e.stopPropagation(), setCriando(false))} />
          <${Button} type="submit" size="sm" variant="primary" loading=${busy} disabled=${!nome.trim()}>Criar</${Button}>
        </form>
        ${erro ? html`<p class="ref-field-error">${erro}</p>` : null}`
      : html`<button type="button" class="ref-pick-item ref-pick-add" onClick=${() => setCriando(true)}><${Icon} name="plus" size=${15} /><span class="ref-pick-name">Nova coleção</span></button>`}
  </div>`
}

/**
 * "Também salvar como": pílulas que ligam e desligam (várias de uma vez). O original sempre vai; cada escolhida vira
 * um arquivo a mais ao lado dele, convertido do mesmo download (não baixa de novo). A escolha fica lembrada.
 */
export function TambemComo({ tipo, valor, onMudar }) {
  const opcoes = formatosPara(tipo).filter((f) => f.id !== 'original')
  const alternar = (id) => {
    const nova = valor.includes(id) ? valor.filter((x) => x !== id) : [...valor, id]
    lembrarTambem(tipo, nova)
    onMudar(nova)
  }
  return html`<div class="k-pilulas rf-tambem" role="group" aria-label="Também salvar como">
    ${opcoes.map(
      (f) => html`<button type="button" class=${cx('k-pilula', valor.includes(f.id) && 'is-on')} aria-pressed=${valor.includes(f.id) ? 'true' : 'false'} onClick=${() => alternar(f.id)} title=${f.sub}>
        ${valor.includes(f.id) ? html`<${Icon} name="check" size=${13} strokeWidth=${2.4} />` : null}${f.curto}
      </button>`,
    )}
  </div>`
}

/**
 * Painel de salvar. `alvo`: { tipo: 'video', url } ou { tipo: 'imagem', imagemUrl, paginaUrl, titulo }.
 * `editarLink`: mostra o campo do link (janela "Colar link"). `onSalvo(trabalho)` depois que o motor aceitou.
 */
export function SalvarReferencia({ alvo, colecaoInicial = null, editarLink = false, origem = 'colar', onSalvo, onCancelar, rotulo = 'Salvar' }) {
  const [url, setUrl] = useState(alvo?.url || '')
  const [colecaoId, setColecaoId] = useState(colecaoInicial)
  const [nota, setNota] = useState('')
  const [det, setDet] = useState(null)
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState(null)
  const imagem = alvo?.tipo === 'imagem'
  const tipoArquivo = imagem ? 'foto' : 'video'
  const [tambem, setTambem] = useState(() => ultimosTambem(tipoArquivo))

  useEffect(() => {
    setUrl(alvo?.url || '')
    setErro(null)
  }, [alvo?.url, alvo?.imagemUrl])

  // De que site é o link (o motor sabe a tabela de plataformas).
  useEffect(() => {
    if (imagem || !url.trim()) return setDet(null)
    let vivo = true
    const t = setTimeout(() => {
      detectarLink(url.trim())
        .then((d) => vivo && setDet(d))
        .catch(() => vivo && setDet(null))
    }, 200)
    return () => {
      vivo = false
      clearTimeout(t)
    }
  }, [url, imagem])

  const valido = imagem ? Boolean(alvo.imagemUrl) : Boolean(det?.url)
  const salvar = async (e) => {
    e?.preventDefault()
    if (!valido || !colecaoId || busy) return
    setBusy(true)
    setErro(null)
    try {
      const res = imagem
        ? await salvarImagem({ imagemUrl: alvo.imagemUrl, paginaUrl: alvo.paginaUrl, titulo: alvo.titulo, colecaoId, nota, formatos: tambem })
        : await salvarLink({ url: det.url, colecaoId, nota, origem, formatos: tambem })
      setNota('')
      onSalvo?.(res.trabalho)
    } catch (err) {
      setErro(err.message)
    } finally {
      setBusy(false)
    }
  }

  const origemTexto = useMemo(() => {
    if (imagem) return alvo.paginaUrl ? urlCurta(alvo.paginaUrl) : 'Imagem'
    return det?.url ? urlCurta(det.url) : ''
  }, [imagem, alvo, det])

  return html`<form class="ref-save" onSubmit=${salvar}>
    ${imagem
      ? html`<div class="ref-save-img">
          <img src=${alvo.imagemUrl} alt="" referrerpolicy="no-referrer" />
          <div><b>Imagem</b><span class="sub">${origemTexto}</span></div>
        </div>`
      : editarLink
        ? html`<div class="field">
            <label class="field-label" for="ref-url">Link do vídeo ou post</label>
            <input id="ref-url" class="input" type="url" inputmode="url" placeholder="https://www.instagram.com/reel/…" value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} data-autofocus autocomplete="off" spellcheck="false" />
            <span class="field-hint">${det?.url ? html`<span class="ref-det"><${Icon} name=${det.salvavel ? 'check' : 'globe'} size=${13} />${det.salvavel ? `${det.nome}` : `${det.nome || 'Site'}: vamos tentar`}</span>` : 'Instagram, YouTube, TikTok, Vimeo, Pinterest, X e outros sites com vídeo.'}</span>
          </div>`
        : html`<div class="ref-save-src">
            <span class="ref-plat">${det?.nome || 'Link'}</span>
            <span class="ref-save-url" title=${url}>${origemTexto}</span>
          </div>`}
    <div class="field">
      <span class="field-label">Coleção</span>
      <${SeletorColecao} value=${colecaoId} onChange=${setColecaoId} />
    </div>
    <div class="field">
      <label class="field-label" for="ref-nota">Nota <span class="sub">(opcional)</span></label>
      <textarea id="ref-nota" class="input ref-nota" rows="2" maxlength="2000" placeholder="Ex.: a luz da janela, o ritmo do corte" value=${nota} onInput=${(e) => setNota(e.currentTarget.value)}></textarea>
    </div>
    <div class="field">
      <span class="field-label">Também salvar como <span class="sub">(opcional)</span></span>
      <${TambemComo} tipo=${tipoArquivo} valor=${tambem} onMudar=${setTambem} />
      <span class="field-hint">${tambem.length ? `O original e ${tambem.map((id) => FORMATOS[id]?.curto).join(', ')}, lado a lado na coleção.` : 'Só o original. Escolha um formato para ter, por exemplo, só o áudio em MP3 320.'}</span>
    </div>
    ${erro ? html`<p class="ref-field-error" role="alert"><${Icon} name="warning" size=${14} />${erro}</p>` : null}
    <div class="ref-save-foot">
      ${onCancelar ? html`<${Button} onClick=${onCancelar}>Cancelar</${Button}>` : null}
      <${Button} type="submit" variant="primary" icon="bookmark" loading=${busy} disabled=${!valido || !colecaoId}>${rotulo}</${Button}>
    </div>
  </form>`
}
