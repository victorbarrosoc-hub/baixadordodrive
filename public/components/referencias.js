// Tela Referências: coleções de vídeos e fotos de referência guardadas no Drive (SOBEDESCE Referências/<Coleção>/).
// Grade de coleções (capa 2 × 2 com as últimas miniaturas) → dentro da coleção, a grade de referências com a mesma
// prévia da tela Drive (player, Baixar original, Abrir no Drive) e a origem de cada uma (link, autor, legenda).
// Salvar: "Colar link" (o computador baixa na hora) ou o navegador de referências (app de desktop).
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, attempt } from '../lib/api.js'
import { cx, useDismiss } from '../lib/ui.js'
import { fullDate, plural, relTime, shortPath } from '../lib/format.js'
import { clipTime } from '../lib/media.js'
import { toast } from '../lib/toasts.js'
import { copyText } from '../lib/mobile.js'
import { announceBatch, driveFolderUrl } from '../lib/actions.js'
import { bridge, openExternal, pickFolderPath } from '../lib/desktop.js'
import { openModal, promptDialog, registerModal } from '../lib/modals.js'
import {
  ATALHOS, ATIVAS, apagarColecao, cancelarTrabalho, carregarColecoes, colecaoPorId, consultarFila, criarColecao, detectarLink, editarColecao, esquecerItens,
  faseTexto, fracaoGeral, removerTrabalho, tentarItemFila, cancelarItemFila, tentarTrabalho, urlCurta, useColecoes, useItens,
} from '../lib/referencias.js'
import { Icon } from './icons.js'
import { Button, IconButton, Spinner, Switch } from './common.js'
import { Barra, BotaoGrande, Destaque, Pagina, Passo, Resumo, Stats, Vazio } from './kit.js'
import { Modal } from './modal.js'
import { Thumb } from './drive-thumb.js'
import { DrivePreview } from './drive-preview.js'
import { SalvarReferencia } from './referencias-salvar.js'

const AVISO = 'Salve só para referência dos seus projetos. Respeite os direitos de quem criou.'

// ─────────── janelas ───────────

function SalvarDialog({ url = '', colecaoId = null, onClose }) {
  return html`<${Modal} size="sm" class="ref-dialog" title="Salvar referência" subtitle="O computador baixa o vídeo e guarda na coleção do seu Drive." onClose=${() => onClose(null)}>
    <${SalvarReferencia}
      alvo=${{ tipo: 'video', url }}
      colecaoInicial=${colecaoId}
      editarLink=${true}
      onCancelar=${() => onClose(null)}
      onSalvo=${(t) => {
        toast('info', `Salvando em ${t?.colecao?.nome || 'sua coleção'}…`, { action: t?.colecao ? { label: 'Ver', href: `#/referencias/${encodeURIComponent(t.colecao.id)}` } : null })
        onClose(t)
      }}
    />
  </${Modal}>`
}

function LinkIaDialog({ colecao: inicial, onClose }) {
  const [c, setC] = useState(inicial)
  const [busy, setBusy] = useState(null)
  const mudar = async (link, label) => {
    setBusy(label)
    const res = await attempt(editarColecao(c.id, { link }))
    if (res) setC({ ...c, ...res })
    setBusy(null)
  }
  const trocar = async () => {
    const ok = await openModal('confirm', { title: 'Trocar o link?', message: 'O link atual para de funcionar. Quem tiver ele não vê mais esta coleção.', confirmLabel: 'Trocar link', danger: true })
    if (ok) mudar('trocar', 'trocar')
  }
  const copiar = async () => {
    const ok = await copyText(c.link)
    toast(ok ? 'success' : 'error', ok ? 'Link copiado.' : 'Não consegui copiar o link.')
  }
  return html`<${Modal} size="sm" class="ref-dialog ref-ia" title="Link pra IA" icon=${html`<${Icon} name="sparkle" size=${20} />`} onClose=${() => onClose(c)}>
    <p class="dialog-text">Uma página com a lista dos vídeos, links e legendas, no formato que IAs leem bem. Cole na IA que vai ajudar no roteiro.</p>
    <div class="ref-ia-row">
      <div>
        <b>Link da coleção</b>
        <span class="sub">${c.link ? 'Ligado. Quem tiver o link vê a lista (não os arquivos).' : 'Desligado.'}</span>
      </div>
      <${Switch} checked=${Boolean(c.link)} label="Link pra IA" disabled=${!!busy} onChange=${(on) => mudar(on, on ? 'ligar' : 'desligar')} />
    </div>
    ${c.link
      ? html`<div class="ref-ia-link">
          <input class="input mono" readonly value=${c.link} onFocus=${(e) => e.currentTarget.select()} aria-label="Link pra IA" />
          <${Button} variant="primary" icon="copy" onClick=${copiar}>Copiar</${Button}>
        </div>
        <div class="ref-ia-actions">
          <${Button} size="sm" variant="ghost" icon="refresh" loading=${busy === 'trocar'} onClick=${trocar}>Trocar link</${Button}>
          <${Button} size="sm" variant="ghost" icon="external" onClick=${() => openExternal(c.link)}>Abrir</${Button}>
        </div>`
      : null}
  </${Modal}>`
}

function ApagarDialog({ colecao, onClose }) {
  const [drive, setDrive] = useState(false)
  return html`<${Modal}
    size="sm"
    class="dialog"
    title=${`Apagar “${colecao.nome}”?`}
    icon=${html`<${Icon} name="warning" size=${20} />`}
    onClose=${() => onClose(null)}
    footer=${html`
      <${Button} onClick=${() => onClose(null)}>Voltar</${Button}>
      <${Button} variant="danger" onClick=${() => onClose({ apagarNoDrive: drive })}>Apagar coleção</${Button}>
    `}
  >
    <p class="dialog-text">A coleção sai da sua lista e o link pra IA para de funcionar.</p>
    <label class="ref-check">
      <input type="checkbox" checked=${drive} onChange=${(e) => setDrive(e.currentTarget.checked)} />
      <span>Apagar também a pasta no Drive <span class="sub">(vai para a lixeira do Drive)</span></span>
    </label>
  </${Modal}>`
}

registerModal('ref-salvar', SalvarDialog)
registerModal('ref-link-ia', LinkIaDialog)
registerModal('ref-apagar', ApagarDialog)

export const abrirSalvar = (props = {}) => openModal('ref-salvar', props)

// ─────────── peças ───────────

/** De que site é o link (o motor sabe a tabela de plataformas), com uma espera curta enquanto a pessoa digita. */
function useDeteccao(url) {
  const [det, setDet] = useState(null)
  useEffect(() => {
    const u = url.trim()
    if (!/^https?:\/\/\S+\.\S+/i.test(u)) return setDet(null)
    let vivo = true
    const t = setTimeout(() => {
      detectarLink(u)
        .then((d) => vivo && setDet(d))
        .catch(() => vivo && setDet(null))
    }, 200)
    return () => {
      vivo = false
      clearTimeout(t)
    }
  }, [url])
  return det
}

/** O campo grande de colar o link: reconhece o site enquanto a pessoa cola e abre "Salvar referência". */
function Colar({ colecaoId, compacto = false, plataformas = false }) {
  const [url, setUrl] = useState('')
  const det = useDeteccao(url)
  const abrir = (u = url) => {
    abrirSalvar({ url: u.trim(), colecaoId }).then((t) => t && setUrl(''))
  }
  const reconhecido = det?.url ? (det.salvavel ? det.nome : `${det.nome || 'Site'}: vamos tentar`) : null
  const ativa = det?.url ? ATALHOS.find((a) => a.nome === det.nome)?.nome || null : null
  const form = html`<form class=${cx('rf-colar', compacto && 'is-compacto', reconhecido && 'is-reconhecido')} onSubmit=${(e) => (e.preventDefault(), abrir())}>
    <span class="rf-colar-ic" aria-hidden="true"><${Icon} name=${det?.salvavel ? 'check' : 'link'} size=${compacto ? 15 : 18} strokeWidth=${1.9} /></span>
    <input
      type="url"
      inputmode="url"
      placeholder=${compacto ? 'Colar link nesta coleção' : 'Cole o link de um vídeo ou post'}
      value=${url}
      onInput=${(e) => setUrl(e.currentTarget.value)}
      onPaste=${(e) => {
        const t = e.clipboardData?.getData('text') || ''
        if (/^\s*https?:\/\//i.test(t)) {
          e.preventDefault()
          setUrl(t.trim())
          abrir(t)
        }
      }}
      aria-label="Colar link de vídeo ou post"
      spellcheck="false"
      autocomplete="off"
    />
    ${reconhecido && !compacto ? html`<span class="k-selo rf-colar-selo" style=${det.salvavel ? '--c:var(--ok)' : '--c:var(--warn)'}>${reconhecido}</span>` : null}
    <button type="submit" class="rf-colar-ir" disabled=${!url.trim()}>Salvar</button>
  </form>`
  return plataformas ? html`${form}<${Plataformas} ativa=${ativa} />` : form
}

/** Os sites em pílulas: o reconhecido acende; tocar abre o site no navegador de referências (ou no navegador). */
function Plataformas({ ativa }) {
  const abrir = (u) => (bridge?.abrirNavegador ? bridge.abrirNavegador(u) : openExternal(u))
  return html`<div class="k-pilulas rf-plats" aria-label="Sites que dá para salvar">
    ${ATALHOS.map(
      (a) => html`<button type="button" class=${cx('k-pilula', ativa === a.nome && 'is-on')} onClick=${() => abrir(a.url)} title=${`Abrir ${a.nome}`}>
        ${a.nome}
      </button>`,
    )}
    <span class="rf-plats-mais">e outros sites com vídeo</span>
  </div>`
}

function Aviso() {
  const visto = useStore((s) => s.settings?.referenciasAvisoVisto)
  if (visto) return null
  const ok = () => attempt(api.patch('/api/settings', { referenciasAvisoVisto: true }))
  return html`<div class="rf-aviso k-entra" role="note" style="--i:1">
    <span class="rf-aviso-ic"><${Icon} name="info" size=${16} /></span>
    <p>${AVISO}</p>
    <${Button} size="sm" onClick=${ok}>Entendi</${Button}>
  </div>`
}

/** O site pediu login (Instagram, TikTok…): o caminho é entrar pelo navegador de referências, não tentar de novo às cegas. */
function pedeLogin(codigo, mensagem) {
  return codigo === 'login' || /pediu login/i.test(mensagem || '')
}

/** "Abrir navegador" na própria linha, já no link que falhou (só no app de desktop). */
function AbrirNavegador({ url }) {
  if (!bridge?.abrirNavegador) return null
  return html`<${Button} size="sm" variant="primary" icon="globe" onClick=${() => bridge.abrirNavegador(url || null)} title="Entre na sua conta no navegador de referências e salve de lá">Abrir navegador</${Button}>`
}

/** Linha de um download em andamento (ou que deu erro). */
function TrabalhoLinha({ t, mostrarColecao, i = 0 }) {
  const ativo = ATIVAS.has(t.fase)
  const frac = fracaoGeral(t)
  const titulo = t.nome ? t.nome.replace(/\.[a-z0-9]+$/i, '') : urlCurta(t.url)
  const cor = t.fase === 'erro' ? 'err' : t.fase === 'pronto' ? 'ok' : t.fase === 'enviando' ? 'up' : 'down'
  return html`<div class=${cx('k-item rf-job k-entra', `is-${t.fase}`)} style=${`--c:var(--${cor});--i:${i}`}>
    <span class="k-item-ic">${ativo ? html`<${Spinner} size=${17} />` : t.fase === 'pronto' ? html`<${Icon} name="check" size=${18} strokeWidth=${2} />` : html`<${Icon} name="warning" size=${18} />`}</span>
    <span class="k-item-txt">
      <span class="rf-job-top">
        <span class="ref-plat">${t.plataformaNome || 'Link'}</span>
        <b title=${t.url}>${titulo}</b>
      </span>
      <span class="rf-job-status">${faseTexto(t)}${mostrarColecao && t.colecao ? html` · em <b>${t.colecao.nome}</b>` : null}</span>
      ${ativo ? html`<${Barra} p=${frac} vivo=${true} label=${faseTexto(t)} />` : null}
    </span>
    <span class="k-item-fim">
      ${ativo && t.fase !== 'concluindo' ? html`<${IconButton} icon="x" label="Cancelar" onClick=${() => attempt(cancelarTrabalho(t.id))} />` : null}
      ${t.fase === 'erro' && pedeLogin(t.erro?.codigo, t.erro?.mensagem) ? html`<${AbrirNavegador} url=${t.url} />` : null}
      ${!ativo && t.fase !== 'pronto' ? html`<${Button} size="sm" icon="retry" onClick=${() => attempt(tentarTrabalho(t.id))}>Tentar de novo</${Button}>` : null}
      ${!ativo && t.fase === 'erro' ? html`<${IconButton} icon="external" label="Abrir o link original" onClick=${() => openExternal(t.url)} />` : null}
      ${!ativo ? html`<${IconButton} icon="x" label="Tirar da lista" onClick=${() => attempt(removerTrabalho(t.id))} />` : null}
    </span>
  </div>`
}

/** Link que veio do celular e ainda está na fila do site (pendente ou com erro). */
function FilaLinha({ i: item, onMudou, i2 = 0 }) {
  const erro = item.status === 'erro'
  return html`<div class=${cx('k-item rf-job k-entra', erro ? 'is-erro' : 'is-na_fila')} style=${`--c:var(--${erro ? 'err' : 'warn'});--i:${i2}`}>
    <span class="k-item-ic">${erro ? html`<${Icon} name="warning" size=${18} />` : html`<${Icon} name="clock" size=${18} />`}</span>
    <span class="k-item-txt">
      <span class="rf-job-top">
        <span class="ref-plat">Do celular</span>
        <b title=${item.url}>${urlCurta(item.url)}</b>
      </span>
      <span class="rf-job-status">${erro ? item.erro || 'Não deu para salvar.' : item.status === 'baixando' ? 'Baixando em outro computador' : 'Na fila: o computador baixa em instantes'}</span>
    </span>
    <span class="k-item-fim">
      ${erro && pedeLogin(null, item.erro) ? html`<${AbrirNavegador} url=${item.url} />` : null}
      ${erro ? html`<${Button} size="sm" icon="retry" onClick=${async () => (await attempt(tentarItemFila(item.id))) && onMudou?.()}>Tentar de novo</${Button}>` : null}
      <${IconButton} icon="external" label="Abrir o link original" onClick=${() => openExternal(item.url)} />
      ${item.status !== 'baixando' ? html`<${IconButton} icon="x" label="Tirar da fila" onClick=${async () => (await attempt(cancelarItemFila(item.id))) && onMudou?.()} />` : null}
    </span>
  </div>`
}

/** "Salvando agora": downloads deste computador e links do celular na fila. */
function Trabalhos({ lista, fila = [], mostrarColecao, onMudou, i = 2 }) {
  if (!lista.length && !fila.length) return null
  const andando = lista.filter((t) => ATIVAS.has(t.fase)).length
  const erros = lista.filter((t) => t.fase === 'erro').length + fila.filter((x) => x.status === 'erro').length
  const sub = [andando ? plural(andando, 'salvando', 'salvando') : null, fila.length ? plural(fila.length, 'do celular', 'do celular') : null, erros ? plural(erros, 'com erro', 'com erro') : null]
    .filter(Boolean)
    .join(' · ')
  return html`<${Passo} icone="download" cor=${erros && !andando ? 'err' : 'up'} titulo="Salvando agora" frase=${sub} i=${i}>
    <div class="k-itens">
      ${lista.map((t, k) => html`<${TrabalhoLinha} key=${t.id} t=${t} mostrarColecao=${mostrarColecao} i=${k} />`)}
      ${fila.map((x, k) => html`<${FilaLinha} key=${x.id} i=${x} i2=${lista.length + k} onMudou=${onMudou} />`)}
    </div>
  </${Passo}>`
}

/** Capa 2 × 2 com as últimas miniaturas da coleção. */
function Capa({ colecao, versao }) {
  const { data, loading } = useItens(colecao.id, { versao, capa: true })
  const itens = (data?.itens || []).slice(0, 4)
  return html`<div class=${cx('ref-cover', `n-${itens.length}`)}>
    ${loading && !data
      ? Array.from({ length: 4 }, () => html`<span class="ref-cover-tile sk"></span>`)
      : itens.length
        ? itens.map((it) => html`<span class="ref-cover-tile"><${Thumb} accountId=${data.accountId} item=${it} size=${320} iconSize=${26} /></span>`)
        : html`<span class="ref-cover-empty"><span class="rf-cover-vazio"><${Icon} name="bookmark" size=${22} strokeWidth=${1.8} /></span></span>`}
  </div>`
}

/** Data do arquivo mais novo da coleção (createdTime). */
function ultimaData(itens) {
  let m = 0
  for (const it of itens || []) {
    const t = Date.parse(it.createdTime || '') || 0
    if (t > m) m = t
  }
  return m || null
}

function ColecaoCard({ c, versao, i = 0, onN }) {
  const { data } = useItens(c.id, { versao, capa: true })
  const n = data?.itens?.length
  const ultima = ultimaData(data?.itens)
  useEffect(() => {
    if (n != null) onN?.(c.id, n)
  }, [c.id, n])
  return html`<a class="rf-col k-entra" href=${`#/referencias/${encodeURIComponent(c.id)}`} title=${c.nome} style=${`--i:${Math.min(i, 12)}`}>
    <span class="rf-col-capa">
      <${Capa} colecao=${c} versao=${versao} />
      ${n ? html`<span class="rf-col-n">${n}</span>` : null}
      ${c.link ? html`<span class="rf-col-ia" title="Link pra IA ligado"><${Icon} name="sparkle" size=${12} strokeWidth=${2} /> IA</span>` : null}
    </span>
    <span class="rf-col-meta">
      <b>${c.nome}</b>
      <span>${n == null ? ' ' : n === 0 ? 'Vazia' : `${plural(n, 'referência', 'referências')}${ultima ? ` · ${relTime(ultima)}` : ''}`}</span>
    </span>
  </a>`
}

function Bloqueio({ motivo, status }) {
  if (motivo === 'plano' || status === 403)
    return html`<${Vazio} icone="bookmark" titulo="Disponível no plano Produtora">
      Com as Referências você guarda vídeos e fotos que inspiram seus projetos direto em coleções no seu Drive.
    </${Vazio}>`
  return html`<${Vazio}
    icone="bookmark"
    titulo="Entre na conta SOBEDESCE"
    acoes=${html`<${Button} variant="primary" icon="cloud" onClick=${() => navigate('ajustes')}>Entrar na conta</${Button}>`}
  >
    As coleções de referências ficam no Drive da sua conta SOBEDESCE.
  </${Vazio}>`
}

const novaColecao = async () => {
  const nome = await promptDialog({ title: 'Nova coleção', label: 'Nome', placeholder: 'Ex.: Clipes, Luz natural, Making of', confirmLabel: 'Criar' })
  if (!nome) return
  const c = await attempt(criarColecao({ nome }))
  if (c) navigate(`referencias/${encodeURIComponent(c.id)}`)
}

/** Coluna da direita da tela de coleções: os números, o que está salvando e o botão de criar. */
function LadoColecoes({ colecoes, total, ativos }) {
  const andando = ativos.filter((t) => ATIVAS.has(t.fase))
  const fracs = andando.map(fracaoGeral)
  const media = fracs.length && fracs.every((f) => f != null) ? fracs.reduce((s, f) => s + f, 0) / fracs.length : null
  return html`
    <${Resumo} titulo="Suas referências">
      <${Stats}
        colunas=${3}
        itens=${[
          { icone: 'bookmark', valor: colecoes ?? '–', rotulo: colecoes === 1 ? 'coleção' : 'coleções', tom: 'down' },
          { icone: 'film', valor: total ?? '–', rotulo: total === 1 ? 'salva' : 'salvas', tom: 'up' },
          { icone: 'download', valor: andando.length, rotulo: 'salvando', tom: andando.length ? 'ok' : 'neutro' },
        ]}
      />
      ${andando.length
        ? html`<${Destaque}
            titulo="Salvando agora"
            numero=${andando.length}
            unidade=${andando.length === 1 ? 'link' : 'links'}
            progresso=${media}
            vivo=${true}
            linha=${`${andando[0].plataformaNome || 'Link'} · ${faseTexto(andando[0])}`}
          />`
        : html`<div class="k-caixa rf-dicas">
            <div class="rf-dica"><span class="rf-dica-ic" style="--c:var(--up)"><${Icon} name="link" size=${15} strokeWidth=${1.9} /></span><span><b>Colar link</b> O computador baixa e guarda na coleção.</span></div>
            <div class="rf-dica"><span class="rf-dica-ic" style="--c:var(--down)"><${Icon} name="monitor" size=${15} strokeWidth=${1.9} /></span><span><b>Do celular</b> Compartilhar → SOBEDESCE.</span></div>
            ${bridge?.abrirNavegador ? html`<div class="rf-dica"><span class="rf-dica-ic" style="--c:var(--ok)"><${Icon} name="globe" size=${15} strokeWidth=${1.9} /></span><span><b>Navegador</b> Entre no Instagram e salve de lá.</span></div>` : null}
          </div>`}
    </${Resumo}>
    <${BotaoGrande} icone="plus" onClick=${novaColecao} dica="Uma por projeto ou por ideia">Nova coleção</${BotaoGrande}>
  `
}

// ─────────── grade de coleções ───────────

function Colecoes({ estado }) {
  const { colecoes, loading, error, status, reload } = useColecoes()
  const [contas, setContas] = useState({})
  const contar = (id, n) => setContas((m) => (m[id] === n ? m : { ...m, [id]: n }))
  const ativos = (estado.trabalhos || []).filter((t) => ATIVAS.has(t.fase) || t.fase === 'erro')
  if (status === 403) return html`<${Bloqueio} status=${403} />`
  const total = colecoes ? colecoes.reduce((s, c) => s + (contas[c.id] || 0), 0) : null
  const todasContadas = colecoes && colecoes.every((c) => contas[c.id] != null)
  return html`<${Pagina}
    titulo="Referências"
    frase="Vídeos e fotos que inspiram seus projetos, guardados em coleções no seu Drive."
    acoes=${bridge?.abrirNavegador ? html`<${Button} icon="globe" onClick=${() => bridge.abrirNavegador()}>Abrir navegador</${Button}>` : null}
    lado=${html`<${LadoColecoes} colecoes=${colecoes?.length ?? null} total=${todasContadas ? total : null} ativos=${ativos} />`}
  >
    <${Aviso} />
    <${Passo} icone="link" cor="up" titulo="Salvar um link" frase="Instagram, YouTube, TikTok e outros. O computador baixa e guarda na coleção que você escolher." i=${1}>
      <${Colar} plataformas=${true} />
    </${Passo}>
    <${Trabalhos} lista=${ativos} mostrarColecao=${true} i=${2} />
    <${Passo}
      icone="bookmark"
      cor="down"
      titulo="Coleções"
      sub=${colecoes?.length ? String(colecoes.length) : null}
      frase="Cada coleção é uma pasta no seu Drive, em SOBEDESCE Referências."
      acao=${html`<div class="rf-acoes">
        <${IconButton} icon="refresh" label="Atualizar" onClick=${() => (esquecerItens(), setContas({}), reload())} class=${loading && colecoes ? 'is-spinning' : ''} />
        <${Button} size="sm" icon="plus" onClick=${novaColecao}>Nova coleção</${Button}>
      </div>`}
      i=${3}
    >
      ${!colecoes && loading
        ? html`<div class="rf-cols">${Array.from({ length: 4 }, () => html`<div class="rf-col"><span class="rf-col-capa"><span class="ref-cover"><span class="ref-cover-tile sk"></span><span class="ref-cover-tile sk"></span><span class="ref-cover-tile sk"></span><span class="ref-cover-tile sk"></span></span></span><span class="rf-col-meta"><span class="sk sk-line" style="width:60%"></span></span></div>`)}</div>`
        : !colecoes && error
          ? html`<div class="table-msg is-error"><${Icon} name="warning" size=${18} /><span>${error}</span><${Button} size="sm" onClick=${reload}>Tentar de novo</${Button}></div>`
          : !colecoes?.length
            ? html`<${Vazio} icone="bookmark" titulo="Nenhuma coleção ainda" acoes=${html`<${Button} variant="primary" icon="plus" onClick=${novaColecao}>Criar a primeira</${Button}>`}>
                Crie uma coleção por projeto ou por ideia: “Clipes”, “Luz natural”, “Campanha verão”.
              </${Vazio}>`
            : html`<div class="rf-cols">
                ${colecoes.map((c, i) => html`<${ColecaoCard} key=${c.id} c=${c} i=${i} versao=${estado.versoes?.[c.id] || 0} onN=${contar} />`)}
              </div>`}
    </${Passo}>
  </${Pagina}>`
}

// ─────────── dentro da coleção ───────────

function RefCard({ it, accountId, onOpen, i = 0 }) {
  const r = it.referencia || {}
  const dur = it.video?.durationMs ? clipTime(it.video.durationMs / 1000) : ''
  const titulo = r.titulo || it.name.replace(/\.[a-z0-9]+$/i, '')
  return html`<button type="button" class="ref-card k-entra" style=${`--i:${Math.min(i, 14)}`} onClick=${onOpen} title=${titulo}>
    <span class="ref-card-thumb">
      <${Thumb} accountId=${accountId} item=${it} size=${640} iconSize=${36} />
      ${r.plataforma ? html`<span class="ref-card-plat">${r.plataforma}</span>` : null}
      ${dur ? html`<span class="gbadge">${dur}</span>` : null}
      <span class="ref-card-play"><${Icon} name=${it.video || /^video\//.test(it.mimeType) ? 'play' : 'eye'} size=${18} /></span>
    </span>
    <span class="ref-card-meta">
      <b>${titulo}</b>
      <span class="sub">${[r.autor, it.createdTime ? relTime(it.createdTime) : null].filter(Boolean).join(' · ')}</span>
    </span>
  </button>`
}

function Origem({ it }) {
  const r = it.referencia || {}
  const [aberta, setAberta] = useState(false)
  if (!r.url && !r.legenda && !r.autor) return null
  const longa = (r.legenda || '').length > 280
  return html`<div class="ref-origem">
    <div class="ref-origem-head">
      ${r.plataforma ? html`<span class="ref-plat">${r.plataforma}</span>` : null}
      ${r.autor ? html`<b>${r.autor}</b>` : null}
    </div>
    ${r.url ? html`<${Button} size="sm" icon="external" onClick=${() => openExternal(r.url)}>Abrir original</${Button}>` : null}
    ${r.nota ? html`<p class="ref-origem-nota"><span class="eyebrow">Nota</span>${r.nota}</p>` : null}
    ${r.legenda
      ? html`<div class=${cx('ref-origem-legenda', longa && !aberta && 'is-clamped')}>
          <span class="eyebrow">Legenda</span>
          <p>${r.legenda}</p>
        </div>
        ${longa ? html`<button type="button" class="link-btn" onClick=${() => setAberta(!aberta)}>${aberta ? 'Mostrar menos' : 'Mostrar tudo'}</button>` : null}`
      : null}
    ${r.salvoEm ? html`<span class="sub ref-origem-quando">Salvo ${fullDate(r.salvoEm)}</span>` : null}
  </div>`
}

function MenuColecao({ c, onClose, onRenomear, onIa, onApagar }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  const item = (icon, label, fn, danger) => html`<button type="button" role="menuitem" class=${cx('menu-item', danger && 'is-danger')} onClick=${() => (onClose(), fn())}><${Icon} name=${icon} size=${15} /><span class="menu-item-text">${label}</span></button>`
  return html`<div class="menu ref-menu" role="menu" ref=${ref}>
    ${item('pencil', 'Renomear', onRenomear)}
    ${item('sparkle', 'Link pra IA', onIa)}
    ${c.driveFolderId ? item('external', 'Abrir no Drive', () => openExternal(driveFolderUrl(c.driveFolderId))) : null}
    <div class="menu-sep"></div>
    ${item('trash', 'Apagar coleção', onApagar, true)}
  </div>`
}

function Colecao({ id, estado }) {
  const { colecoes, status } = useColecoes()
  const versao = estado.versoes?.[id] || 0
  const { data, loading, error, reload } = useItens(id, { versao })
  const settings = useStore((s) => s.settings)
  const home = useStore((s) => s.app?.home)
  const [menu, setMenu] = useState(false)
  const [peek, setPeek] = useState(null)
  const [destDir, setDestDir] = useState(null)
  const c = data?.colecao || colecaoPorId(id) || (colecoes ? null : { id, nome: '' })
  const itens = data?.itens || []
  const trabalhos = (estado.trabalhos || []).filter((t) => t.colecao?.id === id && (ATIVAS.has(t.fase) || t.fase === 'erro'))
  const dest = destDir || settings?.downloadDir || ''
  const videos = itens.filter((it) => it.video || /^video\//.test(it.mimeType || '')).length
  const fotos = itens.filter((it) => /^image\//.test(it.mimeType || '')).length

  useEffect(() => {
    consultarFila()
  }, [id])

  if (status === 403) return html`<${Bloqueio} status=${403} />`
  if (colecoes && !c && !loading)
    return html`<${Vazio} icone="bookmark" titulo="Esta coleção não existe mais" acoes=${html`<${Button} onClick=${() => navigate('referencias')}>Ver coleções</${Button}>`}>
      Ela pode ter sido apagada em outro aparelho.
    </${Vazio}>`

  const renomear = async () => {
    const nome = await promptDialog({ title: 'Renomear coleção', label: 'Nome', initial: c.nome, confirmLabel: 'Renomear' })
    if (nome && nome !== c.nome && (await attempt(editarColecao(c.id, { nome })))) {
      esquecerItens(c.id)
      reload()
    }
  }
  const apagar = async () => {
    const r = await openModal('ref-apagar', { colecao: c })
    if (!r) return
    const ok = await attempt(apagarColecao(c.id, r).then(() => true))
    if (ok) {
      toast('success', `“${c.nome}” apagada.`)
      navigate('referencias')
    }
  }
  const ia = () => openModal('ref-link-ia', { colecao: colecaoPorId(c.id) || c })
  const baixar = async (it) => {
    const res = await attempt(api.post('/api/transfers/download', { accountId: data.accountId, items: [it], destDir: dest }))
    if (res) announceBatch(res, 'na fila')
    return !!res?.count
  }
  const peekIndex = peek ? itens.findIndex((x) => x.id === peek) : -1

  const frase = html`<a class="rf-voltar" href="#/referencias">Referências</a><span class="rf-sep" aria-hidden="true">›</span>${
    data ? (itens.length ? plural(itens.length, 'referência', 'referências') : 'Nada salvo aqui ainda') : ' '
  }${c?.link ? html`<span class="rf-sep" aria-hidden="true">·</span><span class="rf-ia-on"><${Icon} name="sparkle" size=${13} /> link pra IA ligado</span>` : null}`

  const lado = html`
    <${Resumo} titulo="Nesta coleção">
      <${Stats}
        colunas=${3}
        itens=${[
          { icone: 'bookmark', valor: data ? itens.length : '–', rotulo: itens.length === 1 ? 'salva' : 'salvas', tom: 'down' },
          { icone: 'film', valor: data ? videos : '–', rotulo: videos === 1 ? 'vídeo' : 'vídeos', tom: 'up' },
          { icone: 'photo', valor: data ? fotos : '–', rotulo: fotos === 1 ? 'foto' : 'fotos', tom: 'ok' },
        ]}
      />
      <div class="k-caixa rf-ia">
        <div class="rf-ia-top">
          <span class="rf-dica-ic" style="--c:var(--up)"><${Icon} name="sparkle" size=${15} strokeWidth=${1.9} /></span>
          <span><b>Link pra IA</b>${c?.link ? 'Ligado: a lista com links e legendas.' : 'Uma página com a lista, para usar no roteiro.'}</span>
        </div>
        <${Button} size="sm" icon="sparkle" onClick=${ia} disabled=${!c?.id}>${c?.link ? 'Ver o link' : 'Ligar'}</${Button}>
      </div>
    </${Resumo}>
    ${c?.driveFolderId ? html`<${Button} icon="external" onClick=${() => openExternal(driveFolderUrl(c.driveFolderId))}>Abrir no Drive</${Button}>` : null}
  `

  return html`<${Pagina}
    titulo=${c?.nome || html`<span class="sk sk-line" style="width:240px;height:28px"></span>`}
    frase=${frase}
    acoes=${html`<div class="ref-more">
      <${IconButton} icon="more" label="Mais opções" onClick=${() => setMenu(!menu)} class=${menu ? 'is-on' : ''} />
      ${menu && c ? html`<${MenuColecao} c=${c} onClose=${() => setMenu(false)} onRenomear=${renomear} onIa=${ia} onApagar=${apagar} />` : null}
    </div>`}
    lado=${lado}
  >
    <${Aviso} />
    <${Passo} icone="link" cor="up" titulo="Salvar aqui" frase=${`Cole um link: ele entra direto em ${c?.nome || 'esta coleção'}.`} i=${1}>
      <${Colar} colecaoId=${id} />
    </${Passo}>
    <${Trabalhos} lista=${trabalhos} fila=${data?.pendentes || []} onMudou=${reload} i=${2} />
    <${Passo} icone="film" cor="down" titulo="Referências" sub=${itens.length ? String(itens.length) : null} i=${3}>
      ${!data && loading
        ? html`<div class="ref-grid">${Array.from({ length: 8 }, () => html`<div class="ref-card"><span class="ref-card-thumb sk"></span><span class="ref-card-meta"><span class="sk sk-line" style="width:70%"></span></span></div>`)}</div>`
        : !data && error
          ? html`<div class="table-msg is-error"><${Icon} name="warning" size=${18} /><span>${error}</span><${Button} size="sm" onClick=${reload}>Tentar de novo</${Button}></div>`
          : !itens.length
            ? html`<${Vazio} icone="film" titulo="Nada salvo aqui ainda">
                Cole o link de um vídeo ou post${bridge?.abrirNavegador ? ', ou abra o navegador e use “Salvar referência”' : ''}. Do celular, use Compartilhar → SOBEDESCE.
              </${Vazio}>`
            : html`<div class="ref-grid rf-grid">${itens.map((it, i) => html`<${RefCard} key=${it.id} it=${it} i=${i} accountId=${data.accountId} onOpen=${() => setPeek(it.id)} />`)}</div>`}
    </${Passo}>
    ${peekIndex >= 0
      ? html`<${DrivePreview}
          accountId=${data.accountId}
          items=${itens}
          index=${peekIndex}
          onIndex=${(i) => setPeek(itens[i].id)}
          onClose=${() => setPeek(null)}
          onDownload=${baixar}
          dest=${dest}
          destLabel=${shortPath(dest, home)}
          onChangeDest=${async () => {
            const p = await pickFolderPath({ title: 'Onde salvar os downloads?', defaultPath: dest })
            if (p) setDestDir(p)
          }}
          extra=${(it) => html`<${Origem} it=${it} />`}
        />`
      : null}
  </${Pagina}>`
}

// ─────────── tela ───────────

export function ReferenciasScreen({ route }) {
  const ref = useStore((s) => s.referencias)
  const id = route.parts[1] || null

  useEffect(() => {
    if (ref?.ativo) carregarColecoes()
  }, [ref?.ativo])

  // Voltar para a janela: olha a fila do celular agora (além do relógio de 60 s do motor).
  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && ref?.ativo && consultarFila()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ref?.ativo])

  if (ref?.ativo) return id ? html`<${Colecao} key=${id} id=${id} estado=${ref} />` : html`<${Colecoes} estado=${ref} />`
  return html`<${Pagina} titulo="Referências" frase="Vídeos e fotos que inspiram seus projetos, guardados em coleções no seu Drive." class="page-ref">
    ${!ref ? html`<div class="table-msg"><${Spinner} size=${16} /></div>` : html`<${Bloqueio} motivo=${ref.motivo} />`}
  </${Pagina}>`
}
