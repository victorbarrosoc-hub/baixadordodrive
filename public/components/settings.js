// Ajustes, agrupados como nos Ajustes do Sistema do macOS. Cada mudança é salva sozinha (PATCH com atraso curto).
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setSettings, setAccounts, applyTheme } from '../lib/store.js'
import { api, attempt, enc } from '../lib/api.js'
import { relTime, tildify, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { navigate } from '../lib/router.js'
import { confirmDialog, pickLocal } from '../lib/modals.js'
import { toast } from '../lib/toasts.js'
import { Icon } from './icons.js'
import { Avatar, Button, LinkButton, Pill, Segmented, Select, Slider, Stepper, Switch } from './common.js'
import { useLocalRoots } from './local-picker.js'

const MiB = 1048576
const CHUNKS = [
  { value: 64 * MiB, label: '64 MB' },
  { value: 128 * MiB, label: '128 MB' },
  { value: 256 * MiB, label: '256 MB (recomendado)' },
  { value: 512 * MiB, label: '512 MB' },
  { value: 1024 * MiB, label: '1 GB' },
  { value: 0, label: 'Contínuo (sem pedaços)' },
]

function Group({ title, icon, tone, children, foot }) {
  return html`<section class="sgroup">
    <h2 class="sgroup-title">${icon ? html`<span class=${cx('sgroup-icon', tone && `tone-${tone}`)}><${Icon} name=${icon} size=${14} strokeWidth=${1.8} /></span>` : null}${title}</h2>
    <div class="sgroup-box">${children}</div>
    ${foot ? html`<p class="sgroup-foot">${foot}</p>` : null}
  </section>`
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

function LimitControl({ value, onChange, label }) {
  const on = value > 0
  const mbps = on ? Math.round(value / 1e6) : 50
  const [text, setText] = useState(String(mbps))
  useEffect(() => setText(String(on ? Math.round(value / 1e6) : 50)), [value])
  const commit = (t) => {
    const n = Math.max(1, Math.min(100000, Math.round(Number(String(t).replace(',', '.')) || 0)))
    if (n) onChange(n * 1e6)
  }
  return html`<div class="limit">
    ${on
      ? html`<label class="num-field">
          <input
            type="text"
            inputmode="numeric"
            value=${text}
            aria-label=${`${label} em MB/s`}
            onInput=${(e) => setText(e.currentTarget.value.replace(/[^\d,.]/g, ''))}
            onBlur=${(e) => commit(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
          />
          <span>MB/s</span>
        </label>`
      : null}
    <${Switch} checked=${on} label=${label} onChange=${(v) => onChange(v ? mbps * 1e6 : 0)} />
  </div>`
}

export function SettingsScreen() {
  const settings = useStore((s) => s.settings)
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeAccountId)
  const setup = useStore((s) => s.setup)
  const app = useStore((s) => s.app)
  const roots = useLocalRoots()
  const [draft, setDraft] = useState(settings || {})
  const pending = useRef({})
  const timer = useRef(null)
  const [saved, setSaved] = useState(null) // 'saving' | 'saved' | null

  // acompanha mudanças vindas do servidor quando não há edição pendente
  useEffect(() => {
    if (!Object.keys(pending.current).length) setDraft(settings || {})
  }, [settings])

  useEffect(() => () => flush(), [])

  async function flush() {
    clearTimeout(timer.current)
    const patch = pending.current
    if (!Object.keys(patch).length) return
    pending.current = {}
    setSaved('saving')
    try {
      const res = await api.patch('/api/settings', patch)
      setSettings(res.settings)
      if (!Object.keys(pending.current).length) setDraft(res.settings)
      setSaved('saved')
      setTimeout(() => setSaved((s) => (s === 'saved' ? null : s)), 1600)
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
    const p = await pickLocal({ mode: 'folder', title: 'Pasta padrão dos downloads', initialPath: draft.downloadDir })
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

  if (!settings) return null
  const d = { ...settings, ...draft }
  const chunkOpts = CHUNKS.some((c) => c.value === d.uploadChunkSize) ? CHUNKS : [...CHUNKS, { value: d.uploadChunkSize, label: `${Math.round(d.uploadChunkSize / MiB)} MB` }]

  return html`<div class="page page-settings">
    <header class="page-head">
      <h1>Ajustes</h1>
      <div class="page-head-actions">
        <span class=${cx('save-state', saved && 'is-on')} aria-live="polite">
          ${saved === 'saving' ? 'Salvando…' : saved === 'saved' ? html`<${Icon} name="check" size=${14} /> Salvo` : ''}
        </span>
      </div>
    </header>

    <div class="settings">
      <${Group} title="Velocidade" icon="bolt" tone="down">
        <${Row} label="Downloads ao mesmo tempo" desc="Quantos arquivos baixam juntos.">
          <${Stepper} label="Downloads ao mesmo tempo" value=${d.maxConcurrentDownloads} min=${1} max=${8} onChange=${(v) => set('maxConcurrentDownloads', v)} />
        </${Row}>
        <${Row} label="Conexões por arquivo" desc="Cada arquivo baixado é dividido em pedaços que vêm em paralelo. 8–16 costuma encher a banda.">
          <${Slider}
            label="Conexões por arquivo"
            value=${d.connectionsPerDownload}
            min=${1}
            max=${32}
            onInput=${(v) => set('connectionsPerDownload', v)}
            format=${(v) => `${v}`}
          />
        </${Row}>
        <${Row} label="Uploads ao mesmo tempo" desc="O Google recebe um arquivo por vez em cada envio; mais arquivos juntos aproveitam melhor a banda.">
          <${Stepper} label="Uploads ao mesmo tempo" value=${d.maxConcurrentUploads} min=${1} max=${8} onChange=${(v) => set('maxConcurrentUploads', v)} />
        </${Row}>
        <${Row} label="Tamanho do pedaço de upload" desc="Pedaços maiores param menos entre um e outro. Se a conexão cai, o pedaço recomeça.">
          <${Select} label="Tamanho do pedaço de upload" value=${d.uploadChunkSize} options=${chunkOpts} onChange=${(v) => set('uploadChunkSize', Number(v), { now: true })} />
        </${Row}>
        <${Row} label="Refazer conexões lentas" desc="Às vezes o Google segura uma conexão; o SOBEDESCE reabre as que ficam bem para trás.">
          <${Switch} label="Refazer conexões lentas" checked=${d.restartSlowConnections} onChange=${(v) => set('restartSlowConnections', v, { now: true })} />
        </${Row}>
      </${Group}>

      <${Group} title="Limite de banda" icon="gauge" tone="up" foot="Útil para não ocupar a internet do escritório inteiro. Desligado, vai na velocidade máxima.">
        <${Row} label="Limitar download">
          <${LimitControl} label="Limitar download" value=${d.bandwidthLimitDown} onChange=${(v) => set('bandwidthLimitDown', v, { now: true })} />
        </${Row}>
        <${Row} label="Limitar upload">
          <${LimitControl} label="Limitar upload" value=${d.bandwidthLimitUp} onChange=${(v) => set('bandwidthLimitUp', v, { now: true })} />
        </${Row}>
      </${Group}>

      <${Group} title="Segurança e retomada" icon="shield" tone="success">
        <${Row} label="Conferir integridade (MD5)" desc="Depois de cada arquivo, confere se chegou idêntico ao original. Leva um pouquinho mais.">
          <${Switch} label="Conferir integridade" checked=${d.verifyChecksums} onChange=${(v) => set('verifyChecksums', v, { now: true })} />
        </${Row}>
        <${Row} label="Retomar ao abrir" desc="Se o app fechar no meio, continua de onde parou quando abrir de novo.">
          <${Switch} label="Retomar ao abrir" checked=${d.autoResume} onChange=${(v) => set('autoResume', v, { now: true })} />
        </${Row}>
        <${Row} label="Manter o computador acordado" desc="Enquanto houver transferência, o computador não dorme. A tela pode apagar.">
          <${Switch} label="Manter o computador acordado" checked=${d.keepAwake} onChange=${(v) => set('keepAwake', v, { now: true })} />
        </${Row}>
      </${Group}>

      <${Group} title="Arquivos" icon="folder" tone="neutral">
        <${Row} label="Pasta padrão dos downloads" desc=${html`<span class="mono-path" title=${d.downloadDir}>${tildify(d.downloadDir, roots?.home)}</span>`}>
          <${Button} size="sm" onClick=${chooseDownloadDir}>Escolher…</${Button}>
        </${Row}>
        <${Row} label="Quando o arquivo já existe no computador">
          <${Select}
            label="Quando o arquivo já existe no computador"
            value=${d.downloadConflict}
            onChange=${(v) => set('downloadConflict', v, { now: true })}
            options=${[
              { value: 'skip', label: 'Pular se for igual' },
              { value: 'rename', label: 'Baixar com outro nome' },
              { value: 'overwrite', label: 'Substituir o do computador' },
            ]}
          />
        </${Row}>
        <${Row} label="Quando o arquivo já existe no Drive">
          <${Select}
            label="Quando o arquivo já existe no Drive"
            value=${d.uploadConflict}
            onChange=${(v) => set('uploadConflict', v, { now: true })}
            options=${[
              { value: 'skip', label: 'Pular se for igual' },
              { value: 'rename', label: 'Enviar uma cópia' },
              { value: 'replace', label: 'Substituir (vira nova versão)' },
            ]}
          />
        </${Row}>
        <${Row} label="Mostrar arquivos ocultos" desc="No seletor de arquivos do computador.">
          <${Switch} label="Mostrar arquivos ocultos" checked=${d.showHiddenFiles} onChange=${(v) => set('showHiddenFiles', v, { now: true })} />
        </${Row}>
      </${Group}>

      <${Group} title="Aparência" icon="sun" tone="warning">
        <${Row} label="Tema">
          <${Segmented}
            label="Tema"
            value=${d.theme}
            onChange=${(v) => set('theme', v, { now: true })}
            options=${[
              { value: 'system', label: 'Sistema', icon: 'monitor' },
              { value: 'light', label: 'Claro', icon: 'sun' },
              { value: 'dark', label: 'Escuro', icon: 'moon' },
            ]}
          />
        </${Row}>
      </${Group}>

      <${Group} title="Contas" icon="user" tone="up">
        ${accounts.map(
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
          <div class="srow-text"><div class="srow-desc">${accounts.length ? `${plural(accounts.length, 'conta conectada', 'contas conectadas')}. Cada transferência usa a conta de onde veio.` : 'Nenhuma conta conectada.'}</div></div>
          <div class="srow-control"><${LinkButton} size="sm" icon="plus" href="/api/auth/start">Adicionar conta</${LinkButton}></div>
        </div>
      </${Group}>

      <${Group} title="Chave do Google" icon="key" tone="neutral" foot="A chave identifica o seu app no Google. Ela fica só neste computador.">
        <${Row} label="Cliente OAuth" desc=${setup?.clientIdHint ? html`<span class="mono-path">${setup.clientIdHint}</span>` : 'Nenhuma chave configurada'}>
          <${Button} size="sm" onClick=${() => navigate('inicio/chave')}>Trocar chave</${Button}>
        </${Row}>
      </${Group}>

      <p class="about">${app?.name || 'SOBEDESCE'} ${app?.version ? `· versão ${app.version}` : ''} · tudo roda neste computador, direto com o Google.</p>
    </div>
  </div>`
}
