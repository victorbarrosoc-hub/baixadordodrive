// Ajustes no padrão do kit (docs/UI-KIT.md): um passo com ícone por assunto, escolhas em cartões e pílulas, a versão
// num cartão colorido. Cada mudança é salva sozinha (PATCH com atraso curto). Estilos só desta tela: /telas/ajustes.css.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setSettings, setAccounts, applyTheme } from '../lib/store.js'
import { api, attempt, enc } from '../lib/api.js'
import { relTime, tildify, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { navigate } from '../lib/router.js'
import { confirmDialog, pickDriveFolder } from '../lib/modals.js'
import { pickFolderPath, revealLabel, revealPath } from '../lib/desktop.js'
import { toast } from '../lib/toasts.js'
import { copyText, rotateMobileCode, useMobileState } from '../lib/mobile.js'
import { Icon } from './icons.js'
import { Avatar, Button, LinkButton, Pill, Select, Slider, Stepper, Switch } from './common.js'
import { useLocalRoots } from './local-picker.js'
import { CloudAccountRows } from './cloud.js'
import { buildLabel, checkUpdate, downloadingAlone, downloadUpdate, installHint, installUpdate, retryUpdate, updateProgress, updateReady, updating } from '../lib/versao.js'
import { PreviaRow } from './previa.js'
import { Barra, BotaoGrande, Destaque, Item, Opcoes, Pagina, Passo, Pilulas } from './kit.js'

const MiB = 1048576
const CHUNKS = [
  { value: 64 * MiB, label: '64 MB' },
  { value: 128 * MiB, label: '128 MB' },
  { value: 256 * MiB, label: '256 MB' },
  { value: 512 * MiB, label: '512 MB' },
  { value: 1024 * MiB, label: '1 GB' },
  { value: 0, label: 'Contínuo (recomendado)' },
]

// Cor de cada assunto (tokens do kit).
const COR = { down: 'down', up: 'up', success: 'ok', warning: 'warn', neutral: 'text-3' }

/** Um assunto dos ajustes: passo do kit com ícone, as linhas numa caixa e a nota embaixo. */
function Group({ title, icon, tone, children, foot, id, frase, i = 1, rot, extra }) {
  return html`<${Passo} id=${id} icone=${icon} cor=${COR[tone] || 'down'} titulo=${title} frase=${frase} i=${i} class="aj-bloco">
    ${extra}
    ${rot ? html`<p class="k-rot">${rot}</p>` : null}
    ${children ? html`<div class="aj-linhas">${children}</div>` : null}
    ${foot ? html`<p class="k-nota aj-nota"><${Icon} name="info" size=${13} />${foot}</p>` : null}
  </${Passo}>`
}

/** Caixa de linhas com o rótulo em caixa alta (um subgrupo dentro de um passo). */
function Caixa({ rot, children }) {
  return html`${rot ? html`<p class="k-rot">${rot}</p>` : null}<div class="aj-linhas">${children}</div>`
}

function Row({ label, desc, children, stack }) {
  return html`<div class=${cx('srow', stack && 'is-stack')}>
    <div class="srow-text">
      <div class="srow-label">${label}</div>
      ${desc ? html`<div class="srow-desc">${desc}</div>` : null}
    </div>
    <div class="srow-control">${children}</div>
  </div>`
}

// ───── Miniatura de BRAW ─────

/** O Drive não gera miniatura de .braw: o motor tira um frame com o Quick Look (Mac) ou o Explorer (Windows). */
function RawThumbRow({ d, set }) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let live = true
    api.get('/api/raw-thumbs').then((r) => live && setInfo(r.rawThumbs || null)).catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const on = d.brawThumbnails !== false
  let note = null
  if (info && on) {
    if (!info.supported) note = html`<span class="srow-note">Neste sistema ainda não dá para gerar a miniatura.</span>`
    else if (!info.found)
      note = html`<span class="srow-note is-warn">Não encontramos o Blackmagic RAW neste computador.
        <a href=${info.downloadUrl} target="_blank" rel="noopener noreferrer">Baixar o Blackmagic RAW</a></span>`
    else if (info.last && !info.last.ok) note = html`<span class="srow-note">O último RAW enviado ficou sem miniatura (${info.last.reason}).</span>`
  }
  return html`<${Row}
    label="Gerar miniatura de BRAW"
    desc=${html`O Drive não mostra prévia de Blackmagic RAW. Ao terminar o envio, o SOBEDESCE tira um frame e grava como miniatura do arquivo. Precisa do DaVinci Resolve ou do Blackmagic RAW instalado.${note ? html`<br />${note}` : null}`}
  >
    <${Switch} label="Gerar miniatura de BRAW" checked=${on} onChange=${(v) => set('brawThumbnails', v, { now: true })} />
  </${Row}>`
}

// ───── Versão ─────

/**
 * Atualizações: o build deste app num cartão colorido (com a barra enquanto baixa), o que está acontecendo e as ações:
 * "Atualizar" (o app se troca sozinho), "Baixar" (instalador no navegador) e "Procurar atualização".
 */
function Versao() {
  const v = useStore((s) => s.versao)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const atual = v?.atual
  const dev = !atual?.build
  const andando = updating(v)
  const baixando = downloadingAlone(v)
  const pronto = updateReady(v)
  const prog = updateProgress(v?.atualizacao)
  const check = async () => {
    setBusy(true)
    const st = await checkUpdate()
    setBusy(false)
    if (st) setChecked(true)
  }
  let note = null
  if (andando || baixando) note = prog?.label
  else if (pronto) note = `O build ${v.atualizacao.build} já foi baixado e conferido. Atualizar agora fecha o app, troca e abre de novo.`
  else if (prog?.erro) note = prog.label
  else if (v?.disponivel) note = `Saiu o build ${v.ultima.build}. ${installHint(v.plataforma, v.podeAtualizar)}`
  else if (checked && dev) note = 'A versão de desenvolvimento não procura atualização.'
  else if (checked && v?.falhou) note = 'Não consegui verificar agora. Confira a internet e tente de novo.'
  else if (checked) note = 'Você está na versão mais nova.'

  // "build 42 · 15 de out. de 2026" → número grande + a data
  const quando = buildLabel(atual).split(' · ')[1] || ''
  const tom = prog?.erro && !andando && !baixando ? 'erro' : checked && !v?.disponivel && !dev && !v?.falhou ? 'ok' : 'grad'
  const mostrarBarra = andando || baixando
  const titulo = andando ? 'Atualizando agora' : baixando ? 'Baixando a versão nova' : pronto ? 'Versão nova pronta' : 'Versão deste computador'

  return html`<div class="aj-versao">
    <${Destaque}
      titulo=${titulo}
      numero=${pronto || baixando || andando ? v?.atualizacao?.build || v?.ultima?.build || atual?.build || '—' : dev ? 'dev' : atual.build}
      unidade=${dev && !(pronto || baixando || andando) ? 'versão de desenvolvimento' : pronto || baixando || andando ? `build novo · você está no ${atual?.build ?? 'dev'}` : `build${quando ? ` · ${quando}` : ''}`}
      tom=${tom}
      vivo=${mostrarBarra}
    >
      ${mostrarBarra ? html`<${Barra} p=${typeof prog?.fraction === 'number' ? prog.fraction : null} vivo label="Progresso da atualização" />` : null}
      ${note ? html`<span class="k-destaque-linha" aria-live="polite">${note}</span>` : null}
    </${Destaque}>
    <div class="aj-versao-acoes">
      ${pronto && v?.podeAtualizar && !andando
        ? html`<${BotaoGrande} icone="refresh" cheio=${false} onClick=${installUpdate}>Atualizar agora</${BotaoGrande}>`
        : null}
      ${v?.disponivel && !andando && v.podeAtualizar && !baixando && !pronto
        ? prog?.erro
          ? html`<${Button} variant="primary" icon="refresh" onClick=${retryUpdate}>Tentar de novo</${Button}>`
          : html`<${Button} variant="primary" icon="refresh" onClick=${installUpdate}>Atualizar</${Button}>`
        : null}
      ${v?.disponivel && !andando ? html`<${Button} variant=${v.podeAtualizar ? 'secondary' : 'primary'} icon="download" onClick=${downloadUpdate}>Baixar</${Button}>` : null}
      ${andando ? null : html`<${Button} variant="ghost" icon="search" loading=${busy} onClick=${check}>Procurar atualização</${Button}>`}
    </div>
    ${atual?.commit ? html`<p class="k-nota aj-commit" title=${`commit ${atual.commit}`}>commit ${String(atual.commit).slice(0, 7)}</p>` : null}
  </div>`
}

// ───── Celular ─────

/** Endereço em fonte mono com botão de copiar. */
function CopyField({ value, label = 'Copiar' }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    if (await copyText(value)) {
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    } else toast('error', 'Não consegui copiar. Selecione o endereço e copie à mão.')
  }
  return html`<div class="copy-field">
    <span class="mono-path copy-value" title=${value}>${value}</span>
    <${Button} size="sm" icon=${done ? 'check' : 'link'} onClick=${copy}>${done ? 'Copiado' : label}</${Button}>
  </div>`
}

/** SVG gerado pelo motor (qrcode-generator, só retângulos): seguro para pôr direto. */
function QrBox({ svg, label }) {
  return html`<div class="mqr" role="img" aria-label=${label} dangerouslySetInnerHTML=${{ __html: svg }}></div>`
}

/** Campo de texto salvo ao sair dele (ou Enter); o motor valida e, se recusar, volta ao valor anterior. */
function TextSetting({ value, onCommit, placeholder, label, mono, clean = (v) => v.trim(), inputmode, bare = false }) {
  const [text, setText] = useState(value ?? '')
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(value ?? '')
  }, [value])
  const commit = () => {
    editing.current = false
    const v = clean(text)
    setText(v)
    if (v !== (value ?? '')) onCommit(v)
  }
  return html`<input
    class=${cx(!bare && 'input', !bare && 'srow-input', mono && 'mono')}
    type="text"
    inputmode=${inputmode}
    value=${text}
    placeholder=${placeholder}
    aria-label=${label}
    spellcheck="false"
    autocomplete="off"
    onFocus=${() => (editing.current = true)}
    onInput=${(e) => setText(e.currentTarget.value)}
    onBlur=${commit}
    onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()}
  />`
}

function firewallNote(platform) {
  if (platform === 'win32') return 'Na primeira vez, o Windows pode pedir para liberar o SOBEDESCE no Firewall: marque “Redes privadas” e permita. Sem isso o celular não acha o computador.'
  if (platform === 'darwin') return 'Na primeira vez, o macOS pergunta se o SOBEDESCE pode aceitar conexões de entrada: clique em Permitir. Sem isso o celular não acha o Mac.'
  return 'Se houver firewall, libere a porta abaixo para a rede local. Sem isso o celular não acha o computador.'
}

/** Ajustes → Celular: recepção pelo Wi-Fi (QR, pastas, código), Atalho do iPhone e o app publicado na internet. */
function MobileGroups({ d, set, accounts, activeId, home, platform }) {
  const confirmed = useStore((s) => s.settings)
  const cloudOn = useStore((s) => !!s.cloud?.conectado)
  const on = !!d.mobileReceive
  const { state: m, reload, setState } = useMobileState(
    [confirmed?.mobileReceive, confirmed?.mobilePort, confirmed?.mobileStagingDir],
    { poll: !!confirmed?.mobileReceive },
  )
  const [rotating, setRotating] = useState(false)
  const account = accounts.find((a) => a.id === d.mobileAccountId) || accounts.find((a) => a.id === activeId) || accounts[0] || null
  const isMac = platform === 'darwin'
  const where = isMac ? 'o Mac' : 'o computador'
  const toWhere = isMac ? 'ao Mac' : 'ao computador'

  const chooseFolder = async () => {
    if (!account) return toast('error', 'Conecte uma conta do Google primeiro.')
    const f = await pickDriveFolder({ accountId: account.id, title: 'Pasta padrão para o que vem do celular', confirmLabel: 'Usar esta pasta', initialFolderId: d.mobileFolderId || 'root' })
    if (!f) return
    set('mobileAccountId', account.id)
    set('mobileFolderId', f.id === 'root' ? '' : f.id)
    set('mobileFolderName', f.id === 'root' ? '' : f.path || f.name, { now: true })
  }
  const changeAccount = (id) => {
    // A pasta é de uma conta: trocou a conta, volta para o Meu Drive dela.
    set('mobileAccountId', id)
    set('mobileFolderId', '')
    set('mobileFolderName', '', { now: true })
  }
  const chooseStaging = async () => {
    const p = await pickFolderPath({ title: 'Pasta de recebidos do celular', defaultPath: d.mobileStagingDir })
    if (p) set('mobileStagingDir', p, { now: true })
  }
  const rotate = async () => {
    const ok = await confirmDialog({
      title: 'Gerar um código novo?',
      message: 'O QR code, os endereços e o Atalho do iPhone de agora param de funcionar. Envios em andamento caem e continuam depois que o celular abrir o QR novo.',
      confirmLabel: 'Gerar código novo',
    })
    if (!ok) return
    setRotating(true)
    const r = await attempt(rotateMobileCode())
    setRotating(false)
    if (r) {
      setState(r)
      toast('success', 'Código novo pronto. Escaneie o QR de novo no celular.')
    }
  }

  const folderLabel = d.mobileFolderId ? d.mobileFolderName || 'Pasta escolhida' : 'Meu Drive'
  return html`
    <${Group} id="celular" i=${7} title="Celular" icon="drop" tone="up" frase="Pelo QR code, sem conta no celular: ele manda para cá e daqui sobe pro Drive." foot=${on ? firewallNote(platform) : 'O iPhone manda os arquivos pela rede local; o SOBEDESCE daqui sobe pro Drive na velocidade do computador.'}>
      <${Row} label="Receber do celular (mesmo Wi-Fi)" desc=${`O celular abre o SOBEDESCE pelo QR code e manda os arquivos para ${where}, que sobe pro Drive. Se o Wi-Fi cair, continua de onde parou.`}>
        <${Switch} label="Receber do celular" checked=${on} onChange=${(v) => set('mobileReceive', v, { now: true })} />
      </${Row}>
      ${on
        ? html`
            ${m?.error ? html`<div class="srow mobile-error" role="alert"><${Icon} name="warning" size=${16} /><span>${m.error}</span></div>` : null}
            ${m?.running && m.qrSvg
              ? html`<div class="srow mqr-row">
                  <${QrBox} svg=${m.qrSvg} label="QR code para abrir o SOBEDESCE no celular" />
                  <div class="mqr-text">
                    <div class="srow-label">Aponte a câmera do iPhone</div>
                    <div class="srow-desc">Abre no Safari já ligado ${toWhere}, sem login do Google no celular. O celular precisa estar no mesmo Wi-Fi.</div>
                    <${CopyField} value=${m.qrUrl} />
                    ${m.urls.filter((u) => u !== m.qrUrl).length
                      ? html`<details class="more-urls">
                          <summary>Outros endereços</summary>
                          ${m.urls.filter((u) => u !== m.qrUrl).map((u) => html`<${CopyField} key=${u} value=${u} />`)}
                        </details>`
                      : null}
                    ${m.receiving?.length
                      ? html`<div class="mrecv" aria-live="polite">
                          ${m.receiving.map(
                            (r) => html`<div key=${r.id} class="mrecv-row">
                              <${Icon} name="arrow-down" size=${13} />
                              <span class="mrecv-name" title=${r.name}>${r.name}</span>
                              <span class="mrecv-pct">${r.size ? Math.floor((r.offset / r.size) * 100) : 0}%</span>
                            </div>`,
                          )}
                        </div>`
                      : null}
                  </div>
                </div>`
              : !m?.error
                ? html`<div class="srow"><div class="srow-desc">Abrindo a porta para o celular…</div></div>`
                : null}
            <${Row} label="Pasta padrão no Drive" desc=${html`${accounts.length > 1 && account ? html`${account.email} · ` : null}<span class="mono-path" title=${folderLabel}>${folderLabel}</span>`}>
              ${accounts.length > 1
                ? html`<${Select} label="Conta do Google" value=${account?.id || ''} options=${accounts.map((a) => ({ value: a.id, label: a.email }))} onChange=${changeAccount} />`
                : null}
              <${Button} size="sm" onClick=${chooseFolder} disabled=${!account}>Escolher…</${Button}>
            </${Row}>
            <${Row} label="Pasta de recebidos neste computador" desc=${html`<span class="mono-path" title=${d.mobileStagingDir}>${tildify(d.mobileStagingDir, home)}</span>`}>
              ${m?.running ? html`<${Button} size="sm" variant="ghost" onClick=${() => revealPath(d.mobileStagingDir)}>${revealLabel(platform)}</${Button}>` : null}
              <${Button} size="sm" onClick=${chooseStaging}>Escolher…</${Button}>
            </${Row}>
            <${Row} label="Apagar daqui depois de subir" desc="Só depois de o Drive confirmar que o arquivo chegou idêntico (MD5). Desligado, fica uma cópia aqui.">
              <${Switch} label="Apagar daqui depois de subir" checked=${!!d.mobileDeleteAfterUpload} onChange=${(v) => set('mobileDeleteAfterUpload', v, { now: true })} />
            </${Row}>
            <${Row} label="Código de acesso" desc="Só quem tem o código (está no QR) consegue mandar arquivos. Gere outro se o QR vazou.">
              <${Button} size="sm" icon="refresh" loading=${rotating} onClick=${rotate}>Gerar novo código</${Button}>
            </${Row}>
            <${Row} label="Porta" desc="Fica fixa: o QR e o Atalho guardam o endereço com ela. Troque só se outro programa já usa esta.">
              <label class="num-field">
                <${TextSetting}
                  label="Porta da recepção do celular"
                  bare
                  inputmode="numeric"
                  value=${String(d.mobilePort ?? '')}
                  clean=${(v) => v.replace(/\D/g, '').slice(0, 5)}
                  onCommit=${(v) => v && set('mobilePort', Number(v), { now: true })}
                />
              </label>
            </${Row}>
          `
        : null}
    </${Group}>

    ${on
      ? html`<${Group} i=${8} title="Atalho no menu Compartilhar do iPhone" icon="link" tone="neutral" frase="Mande de qualquer app do iPhone pelo botão Compartilhar." foot="O Atalho guarda o código de acesso. Se gerar um código novo, cole o endereço novo no Atalho.">
          <div class="srow is-stack">
            <div class="srow-text">
              <div class="srow-label">Endereço de envio direto</div>
              <div class="srow-desc">Com ele, qualquer app do iPhone manda arquivos para ${where} pelo botão Compartilhar, sem abrir nada.</div>
            </div>
            ${m?.dropUrl ? html`<${CopyField} value=${m.dropUrl} />` : html`<div class="srow-desc">Aparece aqui quando a recepção estiver aberta.</div>`}
            ${m?.dropUrlIp && m.dropUrlIp !== m.dropUrl
              ? html`<div class="srow-desc">Se o iPhone não achar o computador pelo nome, use o endereço com o IP (muda se o roteador trocar o IP):</div>
                  <${CopyField} value=${m.dropUrlIp} />`
              : null}
          </div>
          <ol class="msteps">
            ${(m?.shortcutSteps || []).map((s, i) => html`<li key=${i}>${s}</li>`)}
          </ol>
        </${Group}>`
      : null}

    <${Group}
      i=${9}
      title="Em qualquer lugar (internet)"
      icon="cloud"
      tone="down"
      frase="Fora do Wi-Fi, o app do celular sobe direto pro Google."
      foot="Fora do Wi-Fi, o celular sobe direto pro Google pelo app do site, com os Drives da sua conta SOBEDESCE. Nada passa por este computador."
    >
      <${Row}
        label="Acompanhar pelo celular"
        desc=${html`O celular mostra o andamento das transferências deste computador (nomes dos arquivos e progresso).${cloudOn ? null : html`<br /><span class="srow-note">Funciona com a conta SOBEDESCE: entre nela lá em cima.</span>`}`}
      >
        <${Switch} label="Acompanhar pelo celular" checked=${d.acompanharCelular !== false} onChange=${(v) => set('acompanharCelular', v, { now: true })} />
      </${Row}>
      ${m?.webQrSvg
        ? html`<div class="srow mqr-row">
            <${QrBox} svg=${m.webQrSvg} label="QR code do app do celular" />
            <div class="mqr-text">
              <div class="srow-label">Escaneie com o iPhone</div>
              <div class="srow-desc">Abre o app do celular. Entre na sua conta SOBEDESCE e escolha o Drive.</div>
              <${CopyField} value=${m.webUrl} />
            </div>
          </div>`
        : null}
    </${Group}>
  `
}

function LimitControl({ value, onChange, label }) {
  const on = value > 0
  const mbps = on ? Math.round(value / 1e6) : 50
  const [text, setText] = useState(String(mbps))
  const editing = useRef(false)
  // valor novo vindo do motor não atropela o que a pessoa está digitando
  useEffect(() => {
    if (!editing.current) setText(String(on ? Math.round(value / 1e6) : 50))
  }, [value])
  const commit = (t) => {
    const raw = Number(String(t).replace(',', '.'))
    // vazio ou zero volta ao valor atual (desligar é no interruptor), em vez de virar 1 MB/s sem querer
    if (!String(t).trim() || !Number.isFinite(raw) || raw <= 0) return setText(String(mbps))
    const n = Math.max(1, Math.min(100000, Math.round(raw)))
    setText(String(n))
    if (n * 1e6 !== value) onChange(n * 1e6)
  }
  return html`<div class="limit">
    ${on
      ? html`<label class="num-field">
          <input
            type="text"
            inputmode="numeric"
            value=${text}
            aria-label=${`${label} em MB/s`}
            onFocus=${() => (editing.current = true)}
            onInput=${(e) => setText(e.currentTarget.value.replace(/[^\d,.]/g, ''))}
            onBlur=${(e) => {
              editing.current = false
              commit(e.currentTarget.value)
            }}
            onKeyDown=${(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
          />
          <span>MB/s</span>
        </label>`
      : null}
    <${Switch} checked=${on} label=${label} onChange=${(v) => onChange(v ? mbps * 1e6 : 0)} />
  </div>`
}

/** Ajustes → Avançado: onde os tokens dos Drives e a sessão da conta ficam guardados (src/util/segredos.js). */
function protecaoTexto(app) {
  if (app?.protecao !== 'sistema') return 'Num arquivo que só o seu usuário lê. Este computador não ofereceu um cofre do sistema.'
  const cofre = app.platform === 'darwin' ? 'no Keychain do macOS' : app.platform === 'win32' ? 'com a proteção de dados do Windows' : 'no chaveiro do sistema'
  return `Os acessos aos Drives, a sessão da conta e os logins do navegador de referências ficam cifrados ${cofre}.`
}

// ───── Índice lateral (janelas a partir de 1280 px; abaixo disso fica escondido pelo CSS) ─────

// Cada item marca o trecho da página que começa na seção dele e vai até a do próximo (ex.: "Velocidade" cobre
// Velocidade, Limite de banda e Segurança e retomada; "Avançado" cobre o avançado e as chaves do Google).
const INDICE = [
  { id: 'contas', label: 'Conta', icon: 'cloud', cor: 'up' },
  { id: 'velocidade', label: 'Velocidade', icon: 'bolt', cor: 'down' },
  { id: 'arquivos', label: 'Arquivos', icon: 'folder', cor: 'warn' },
  { id: 'celular', label: 'Celular', icon: 'drop', cor: 'up' },
  { id: 'aparencia', label: 'Aparência', icon: 'sun', cor: 'warn' },
  { id: 'atualizacoes', label: 'Atualizações', icon: 'circle-down', cor: 'down' },
  { id: 'avancado', label: 'Avançado', icon: 'sliders', cor: 'text-3' },
]
const LINHA_ATIVA = 120 // px do topo: a seção cujo título passou desta linha é a "visível"

/** Qual item do índice está na tela: a última seção que já passou da linha; no fim da página, a última que aparece. */
function secaoVisivel() {
  // A seção cujo topo está mais perto da linha (de cima). Numa coluna só, é a última que passou da linha; em tela
  // larga os grupos vão em duas colunas, e a ordem do índice não diz mais quem está mais embaixo.
  let ativo = INDICE[0].id
  let melhor = -Infinity
  for (const s of INDICE) {
    const el = document.getElementById(s.id)
    const top = el ? el.getBoundingClientRect().top : Infinity
    if (top <= LINHA_ATIVA && top > melhor) {
      melhor = top
      ativo = s.id
    }
  }
  const fim = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
  if (fim) {
    const ultimo = document.getElementById(INDICE[INDICE.length - 1].id)
    if (ultimo && ultimo.getBoundingClientRect().top < window.innerHeight) ativo = INDICE[INDICE.length - 1].id
  }
  return ativo
}

function useSecaoVisivel(pronto) {
  const [ativo, setAtivo] = useState(INDICE[0].id)
  const clicado = useRef(null) // depois de um clique, fica marcado o clicado até a rolagem suave terminar
  const solta = useRef(null)
  useEffect(() => {
    if (!pronto) return undefined
    let quadro = 0
    const medir = () => {
      quadro = 0
      if (clicado.current) {
        clearTimeout(solta.current)
        solta.current = setTimeout(() => (clicado.current = null), 180)
        return
      }
      setAtivo(secaoVisivel())
    }
    const aoRolar = () => {
      if (!quadro) quadro = requestAnimationFrame(medir)
    }
    medir()
    window.addEventListener('scroll', aoRolar, { passive: true })
    window.addEventListener('resize', aoRolar)
    return () => {
      cancelAnimationFrame(quadro)
      clearTimeout(solta.current)
      window.removeEventListener('scroll', aoRolar)
      window.removeEventListener('resize', aoRolar)
    }
  }, [pronto])
  const ir = (id) => {
    const el = document.getElementById(id)
    if (!el) return
    if (el.tagName === 'DETAILS') el.open = true
    clicado.current = id
    clearTimeout(solta.current)
    solta.current = setTimeout(() => (clicado.current = null), 900) // sem rolagem (já estava lá): solta sozinho
    setAtivo(id)
    const reduzir = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'start', behavior: reduzir ? 'auto' : 'smooth' })
  }
  return [ativo, ir]
}

function IndiceAjustes({ ativo, onIr }) {
  return html`<nav class="settings-index aj-indice k-entra" style="--i:1" aria-label="Seções dos ajustes">
    <p class="k-resumo-tit">Seções</p>
    <ul>
      ${INDICE.map(
        (s) => html`<li key=${s.id}>
          <a
            href=${`#/ajustes/${s.id}`}
            class=${cx('settings-index-item', ativo === s.id && 'is-on')}
            aria-current=${ativo === s.id ? 'location' : undefined}
            onClick=${(e) => {
              e.preventDefault()
              onIr(s.id)
            }}
          >
            <span class="aj-indice-ic" style=${`--c:var(--${s.cor})`}><${Icon} name=${s.icon} size=${14} strokeWidth=${1.9} /></span><span>${s.label}</span>
          </a>
        </li>`,
      )}
    </ul>
  </nav>`
}

/** Quantos ao mesmo tempo: o número grande em gradiente, atalhos em pílulas e o ajuste fino (como no Frames). */
function Quantos({ titulo, dica, valor, min, max, atalhos, onChange, unidade }) {
  const temAtalho = atalhos.includes(valor)
  return html`<div class="aj-quant k-faixa">
    <div class="k-numero aj-quant-num"><b key=${valor}>${valor}</b><span>${unidade}</span></div>
    <div class="aj-quant-ctl">
      <b class="aj-quant-tit">${titulo}</b>
      ${dica ? html`<span class="aj-quant-dica">${dica}</span>` : null}
      <div class="aj-quant-linha">
        <${Pilulas} label=${`${titulo}: atalhos`} valor=${temAtalho ? valor : null} itens=${atalhos.map((n) => ({ value: n, label: String(n) }))} onEscolher=${onChange} />
        <${Stepper} label=${titulo} value=${valor} min=${min} max=${max} onChange=${onChange} />
      </div>
    </div>
  </div>`
}

/** Tema em cartões, cada um com um desenho da janela no tema. */
const TEMAS = [
  { value: 'system', titulo: 'Sistema', sub: 'Segue o computador', icone: 'monitor' },
  { value: 'light', titulo: 'Claro', sub: 'Fundo branco', icone: 'sun' },
  { value: 'dark', titulo: 'Escuro', sub: 'Fundo preto', icone: 'moon' },
]
function Temas({ valor, onEscolher }) {
  return html`<div class="k-opcoes aj-temas" role="radiogroup" aria-label="Tema" style="--n:3">
    ${TEMAS.map(
      (t) => html`<button
        type="button"
        role="radio"
        aria-checked=${t.value === valor ? 'true' : 'false'}
        class=${cx('k-opcao aj-tema', t.value === valor && 'is-on')}
        onClick=${() => onEscolher(t.value)}
      >
        <span class=${cx('aj-tema-arte', `is-${t.value}`)} aria-hidden="true">
          <i class="aj-tema-lado"></i><i class="aj-tema-linha"></i><i class="aj-tema-linha is-curta"></i><i class="aj-tema-bloco"></i>
        </span>
        <b><${Icon} name=${t.icone} size=${14} strokeWidth=${1.9} /> ${t.titulo}</b>
        <span>${t.sub}</span>
        <span class="k-opcao-ok" aria-hidden="true"><${Icon} name="check" size=${12} strokeWidth=${2.4} /></span>
      </button>`,
    )}
  </div>`
}

const CONFLITO_PC = [
  { value: 'skip', titulo: 'Pular se for igual', sub: 'Não baixa de novo', icone: 'check' },
  { value: 'rename', titulo: 'Outro nome', sub: 'Baixa ao lado, com (2)', icone: 'copy' },
  { value: 'overwrite', titulo: 'Substituir', sub: 'Troca o do computador', icone: 'refresh' },
]
const CONFLITO_DRIVE = [
  { value: 'skip', titulo: 'Pular se for igual', sub: 'Não envia de novo', icone: 'check', up: true },
  { value: 'rename', titulo: 'Enviar uma cópia', sub: 'Fica ao lado no Drive', icone: 'copy', up: true },
  { value: 'replace', titulo: 'Substituir', sub: 'Vira nova versão no Drive', icone: 'stack', up: true },
]

const mbps = (v) => `${Math.round(v / 1e6)} MB/s`

export function SettingsScreen({ route } = {}) {
  const settings = useStore((s) => s.settings)
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeAccountId)
  const setup = useStore((s) => s.setup)
  const app = useStore((s) => s.app)
  const roots = useLocalRoots()
  const localAccounts = accounts.filter((a) => a.source !== 'nuvem')
  const [draft, setDraft] = useState(settings || {})
  const pending = useRef({})
  const timer = useRef(null)
  const inflight = useRef(Promise.resolve())
  const savedTimer = useRef(null)
  const [saved, setSaved] = useState(null) // 'saving' | 'saved' | null

  // acompanha mudanças vindas do servidor quando não há edição pendente
  useEffect(() => {
    if (!Object.keys(pending.current).length) setDraft(settings || {})
  }, [settings])

  useEffect(() => () => flush(), [])

  // Um PATCH por vez: dois em paralelo podem chegar fora de ordem ao motor e o valor antigo venceria
  // (ex.: ligar o limite de banda e logo digitar outro número).
  function flush() {
    clearTimeout(timer.current)
    inflight.current = inflight.current.then(send)
    return inflight.current
  }

  async function send() {
    const patch = pending.current
    if (!Object.keys(patch).length) return
    pending.current = {}
    clearTimeout(savedTimer.current)
    setSaved('saving')
    try {
      const res = await api.patch('/api/settings', patch)
      setSettings(res.settings)
      if (!Object.keys(pending.current).length) setDraft(res.settings)
      setSaved('saved')
      // um timer só: o de um salvamento anterior apagava o "Salvo" do seguinte logo que aparecia
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved((s) => (s === 'saved' ? null : s)), 1600)
    } catch (err) {
      toast('error', err.message)
      setSaved(null)
      setDraft(settings || {})
    }
  }

  const set = (key, value, { now = false } = {}) => {
    setDraft((d) => ({ ...d, [key]: value }))
    pending.current = { ...pending.current, [key]: value }
    if (key === 'theme') applyTheme(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, now ? 0 : 450)
  }

  const chooseDownloadDir = async () => {
    const p = await pickFolderPath({ title: 'Pasta padrão dos downloads', defaultPath: draft.downloadDir })
    if (p) set('downloadDir', p, { now: true })
  }

  const removeAccount = async (acc) => {
    const ok = await confirmDialog({
      title: `Remover ${acc.email}?`,
      message: 'O SOBEDESCE esquece o acesso a esta conta. Nada é apagado do Drive; dá para conectar de novo quando quiser.',
      confirmLabel: 'Remover conta',
      danger: true,
    })
    if (!ok) return
    const res = await attempt(api.del(`/api/accounts/${enc(acc.id)}`, {}))
    if (res) {
      setAccounts(res.accounts || [])
      toast('success', 'Conta removida.')
    }
  }

  // #/ajustes/contas (menu da conta → "Conta e Drives"): rola até a seção e marca por um instante.
  // Espera um quadro: a troca de rota volta a página para o topo depois deste efeito.
  const section = route?.parts?.[1] || ''
  useEffect(() => {
    if (!section || !settings) return undefined
    const t = setTimeout(() => {
      const el = document.getElementById(section)
      if (!el) return
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      el.classList.remove('is-flash')
      void el.offsetWidth
      el.classList.add('is-flash')
    }, 30)
    return () => clearTimeout(t)
  }, [section, !!settings])

  const [secao, irPara] = useSecaoVisivel(Boolean(settings))

  if (!settings) return null
  const d = { ...settings, ...draft }
  const chunkOpts = CHUNKS.some((c) => c.value === d.uploadChunkSize) ? CHUNKS : [...CHUNKS, { value: d.uploadChunkSize, label: `${Math.round(d.uploadChunkSize / MiB)} MB` }]

  const salvo = html`<span class=${cx('save-state aj-salvo', saved && 'is-on')} aria-live="polite">
    ${saved === 'saving' ? 'Salvando…' : saved === 'saved' ? html`<${Icon} name="check" size=${14} /> Salvo` : ''}
  </span>`
  const banda = d.bandwidthLimitDown > 0 || d.bandwidthLimitUp > 0
  const visao = [
    { id: 'velocidade', icone: 'download', tom: 'down', valor: d.maxConcurrentDownloads, rotulo: 'downloads juntos' },
    { id: 'velocidade', icone: 'upload', tom: 'up', valor: d.maxConcurrentUploads, rotulo: 'uploads juntos' },
    {
      id: 'velocidade',
      icone: 'gauge',
      tom: banda ? 'warn' : 'neutro',
      valor: banda ? [d.bandwidthLimitDown > 0 && `↓ ${mbps(d.bandwidthLimitDown)}`, d.bandwidthLimitUp > 0 && `↑ ${mbps(d.bandwidthLimitUp)}`].filter(Boolean).join('  ') : 'Livre',
      rotulo: banda ? 'limite de banda' : 'sem limite de banda',
    },
    { id: 'seguranca', icone: 'shield', tom: d.verifyChecksums ? 'ok' : 'erro', valor: d.verifyChecksums ? 'MD5' : 'Sem MD5', rotulo: d.verifyChecksums ? 'confere cada arquivo' : 'não confere os arquivos' },
  ]

  return html`<${Pagina} titulo="Ajustes" frase="Tudo é salvo sozinho. Mude o que precisar e siga trabalhando." acoes=${salvo} class="page-settings page-ajustes">
    <div class="aj-layout">
      <${IndiceAjustes} ativo=${secao} onIr=${irPara} />
      <div class="aj-main">
        <div class="k-stats aj-visao k-entra" style="--n:4; --i:1" role="list" aria-label="Resumo dos ajustes">
          ${visao.map(
            (v) => html`<button type="button" role="listitem" class=${cx('k-stat aj-visao-item', v.tom !== 'down' && `is-${v.tom}`)} onClick=${() => irPara(v.id)}>
              <span class="k-stat-ic"><${Icon} name=${v.icone} size=${15} strokeWidth=${1.9} /></span>
              <b>${v.valor}</b>
              <span>${v.rotulo}</span>
            </button>`,
          )}
        </div>

        <${Group} id="contas" i=${2} title="Conta SOBEDESCE" icon="cloud" tone="up" frase="Os Drives da sua conta, sem chave do Google." foot="Os arquivos vão direto deste computador para o Google. O site só guarda o acesso aos seus Drives.">
          <${CloudAccountRows} />
        </${Group}>

        <${Group}
          id="velocidade"
          i=${3}
          title="Velocidade"
          icon="bolt"
          tone="down"
          frase="Quantos arquivos andam juntos. Mais arquivos enchem a banda."
          extra=${html`<div class="aj-quants">
            <${Quantos}
              titulo="Downloads ao mesmo tempo"
              dica="Quantos arquivos baixam juntos."
              unidade="baixando"
              valor=${d.maxConcurrentDownloads}
              min=${1}
              max=${16}
              atalhos=${[1, 3, 6, 10]}
              onChange=${(v) => set('maxConcurrentDownloads', v)}
            />
            <${Quantos}
              titulo="Uploads ao mesmo tempo"
              dica="4 para 1 Gbps, 12 a 16 para 10 Gbps."
              unidade="subindo"
              valor=${d.maxConcurrentUploads}
              min=${1}
              max=${16}
              atalhos=${[2, 4, 8, 16]}
              onChange=${(v) => set('maxConcurrentUploads', v)}
            />
          </div>`}
          rot="Limite de banda"
          foot="Útil para não ocupar a internet do escritório inteiro. Desligado, vai na velocidade máxima. Cada arquivo chega ao Google a uns 40–100 MB/s."
        >
          <${Row} label="Limitar download" desc="Até quantos MB/s baixar do Drive.">
            <${LimitControl} label="Limitar download" value=${d.bandwidthLimitDown} onChange=${(v) => set('bandwidthLimitDown', v, { now: true })} />
          </${Row}>
          <${Row} label="Limitar upload" desc="Até quantos MB/s subir pro Drive.">
            <${LimitControl} label="Limitar upload" value=${d.bandwidthLimitUp} onChange=${(v) => set('bandwidthLimitUp', v, { now: true })} />
          </${Row}>
        </${Group}>

        <${Group} id="seguranca" i=${4} title="Segurança e retomada" icon="shield" tone="success" frase="Cada arquivo conferido e nada perdido se o app fechar.">
          <${Row}
            label="Conferir integridade (MD5)"
            desc=${html`Depois de cada arquivo, confere se chegou idêntico ao original. Leva um pouquinho mais.${!d.verifyChecksums
              ? html`<span class="srow-note is-warn" role="status"><${Icon} name="warning" size=${13} />Sem conferir, um arquivo corrompido passa sem aviso.</span>`
              : null}`}
          >
            <${Switch} label="Conferir integridade" checked=${d.verifyChecksums} onChange=${(v) => set('verifyChecksums', v, { now: true })} />
          </${Row}>
          <${Row} label="Retomar ao abrir" desc="Se o app fechar no meio, continua de onde parou quando abrir de novo.">
            <${Switch} label="Retomar ao abrir" checked=${d.autoResume} onChange=${(v) => set('autoResume', v, { now: true })} />
          </${Row}>
          <${Row} label="Manter o computador acordado" desc="Enquanto houver transferência, o computador não dorme. A tela pode apagar.">
            <${Switch} label="Manter o computador acordado" checked=${d.keepAwake} onChange=${(v) => set('keepAwake', v, { now: true })} />
          </${Row}>
        </${Group}>

        <${Group}
          id="arquivos"
          i=${5}
          title="Arquivos"
          icon="folder"
          tone="warning"
          frase="Onde os downloads caem e o que fazer quando o arquivo já existe."
          extra=${html`<${Item}
              icone="folder"
              tom="warn"
              titulo="Pasta padrão dos downloads"
              sub=${html`<span class="mono-path" title=${d.downloadDir}>${tildify(d.downloadDir, roots?.home)}</span>`}
              fim=${html`<${Button} size="sm" onClick=${chooseDownloadDir}>Escolher…</${Button}>`}
            />
            <p class="k-rot">Quando o arquivo já existe no computador</p>
            <${Opcoes} label="Quando o arquivo já existe no computador" valor=${d.downloadConflict} itens=${CONFLITO_PC} colunas=${3} onEscolher=${(v) => set('downloadConflict', v, { now: true })} />
            <p class="k-rot">Quando o arquivo já existe no Drive</p>
            <${Opcoes} label="Quando o arquivo já existe no Drive" valor=${d.uploadConflict} itens=${CONFLITO_DRIVE} colunas=${3} onEscolher=${(v) => set('uploadConflict', v, { now: true })} />`}
          rot="Prévias e seletor"
        >
          <${RawThumbRow} d=${d} set=${set} />
          <${PreviaRow} d=${d} set=${set} />
          <${Row} label="Mostrar arquivos ocultos" desc="No seletor de arquivos do computador.">
            <${Switch} label="Mostrar arquivos ocultos" checked=${d.showHiddenFiles} onChange=${(v) => set('showHiddenFiles', v, { now: true })} />
          </${Row}>
        </${Group}>

        <${MobileGroups} d=${d} set=${set} accounts=${accounts} activeId=${activeId} home=${roots?.home} platform=${app?.platform} />

        <${Group}
          id="aparencia"
          i=${10}
          title="Aparência"
          icon="sun"
          tone="warning"
          frase="Claro, escuro ou igual ao computador."
          extra=${html`<${Temas} valor=${d.theme} onEscolher=${(v) => set('theme', v, { now: true })} />`}
        />

        <${Group}
          id="atualizacoes"
          i=${11}
          title="Atualizações"
          icon="circle-down"
          tone="down"
          frase="O app avisa quando sai uma versão nova e já baixa sozinho."
          extra=${html`<${Versao} />`}
          foot="Atualizar baixa, confere e troca o app sozinho; Baixar abre o instalador no navegador. Seus ajustes e a fila continuam."
        />

        <details class="k-passo aj-bloco aj-avancado k-entra" style="--i:12" id="avancado">
          <summary class="k-passo-cabeca">
            <span class="k-n is-icone" style="--c:var(--text-3)"><${Icon} name="sliders" size=${16} strokeWidth=${1.8} /></span>
            <span class="k-passo-tit">
              <h2>Avançado</h2>
              <p>Pedaço de upload, conexões por arquivo, Drives só neste computador e a chave do Google.</p>
            </span>
            <${Icon} name="chevron-right" size=${16} class="aj-chev" />
          </summary>
          <p class="k-rot">Tamanho do pedaço de upload</p>
          <div class="aj-pedaco">
            <${Pilulas}
              label="Tamanho do pedaço de upload"
              valor=${d.uploadChunkSize}
              itens=${chunkOpts.map((c) => ({ value: c.value, label: c.value === 0 ? 'Contínuo' : c.label }))}
              onEscolher=${(v) => set('uploadChunkSize', Number(v), { now: true })}
            />
            <span class="aj-pedaco-dica">${d.uploadChunkSize === 0
              ? 'Contínuo (recomendado): o resto do arquivo numa requisição só, como o Google indica.'
              : 'Pedaços ajudam em redes que derrubam conexões longas; se cair, continua de onde o Google confirmou.'}</span>
          </div>
          <${Caixa} rot="Conexões">
            <${Row} label="Conexões por arquivo" desc="Cada arquivo baixado vem em pedaços paralelos. Entre 8 e 16 costuma encher a banda.">
              <${Slider}
                label="Conexões por arquivo"
                value=${d.connectionsPerDownload}
                min=${1}
                max=${32}
                onInput=${(v) => set('connectionsPerDownload', v)}
                format=${(v) => `${v}`}
              />
            </${Row}>
            <${Row} label="Refazer conexões lentas" desc="Às vezes o Google segura uma conexão; o SOBEDESCE reabre as que ficam bem para trás.">
              <${Switch} label="Refazer conexões lentas" checked=${d.restartSlowConnections} onChange=${(v) => set('restartSlowConnections', v, { now: true })} />
            </${Row}>
            ${app?.desktop ? html`<${Row} label="Onde ficam os acessos" desc=${protecaoTexto(app)} />` : null}
          </${Caixa}>

          <${Caixa} rot="Drives só neste computador">
            ${localAccounts.map(
              (a) => html`<div class="srow account-row">
                <div class="account-id">
                  <${Avatar} name=${a.name} email=${a.email} photoUrl=${a.photoUrl} size=${32} />
                  <div class="srow-text">
                    <div class="srow-label">${a.name || a.email} ${a.id === activeId ? html`<${Pill} tone="neutral">Em uso</${Pill}>` : null}</div>
                    <div class="srow-desc">${a.email}${a.addedAt ? ` · conectada ${relTime(a.addedAt)}` : ''}</div>
                  </div>
                </div>
                <div class="srow-control">
                  ${a.status === 'reauth' ? html`<${LinkButton} size="sm" variant="primary" href="/api/auth/start">Conectar de novo</${LinkButton}>` : null}
                  <${Button} size="sm" variant="ghost-danger" onClick=${() => removeAccount(a)}>Remover</${Button}>
                </div>
              </div>`,
            )}
            <div class="srow">
              <div class="srow-text"><div class="srow-desc">${localAccounts.length ? `${plural(localAccounts.length, 'Drive conectado', 'Drives conectados')} com a sua chave do Google, guardados só aqui.` : 'Com a sua própria chave do Google, sem passar pela conta. Para quem prefere assim.'}</div></div>
              <div class="srow-control">
                ${setup?.configured
                  ? html`<${LinkButton} size="sm" icon="plus" href="/api/auth/start">Conectar um Drive só neste computador</${LinkButton}>`
                  : html`<${Button} size="sm" icon="plus" onClick=${() => navigate('inicio/local')}>Conectar um Drive só neste computador</${Button}>`}
              </div>
            </div>
          </${Caixa}>

          ${setup?.configured || localAccounts.length
            ? html`<${Caixa} rot="Chave do Google">
                  <${Row} label="Cliente OAuth" desc=${setup?.clientIdHint ? html`<span class="mono-path">${setup.clientIdHint}</span>` : 'Nenhuma chave configurada'}>
                    <${Button} size="sm" onClick=${() => navigate('inicio/chave')}>Trocar chave</${Button}>
                  </${Row}>
                </${Caixa}>
                <p class="k-nota aj-nota"><${Icon} name="info" size=${13} />A chave identifica o seu app no Google. Ela fica só neste computador e só vale para os Drives conectados aqui.</p>`
            : null}
          <p class="k-nota aj-nota"><${Icon} name="info" size=${13} />O padrão já serve para quase toda rede. Mexa aqui se o envio cair muito ou não encher a banda.</p>
        </details>

        <p class="about">${app?.name || 'SOBEDESCE'} ${app?.version ? `· versão ${app.version}` : ''} · tudo roda neste computador, direto com o Google.</p>
      </div>
    </div>
  </${Pagina}>`
}
