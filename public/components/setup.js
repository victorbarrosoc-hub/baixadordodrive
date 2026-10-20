// Primeiros passos: criar a chave no Google, colar a chave, conectar a conta.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setSetup, getState } from '../lib/store.js'
import { api } from '../lib/api.js'
import { navigate } from '../lib/router.js'
import { cx, usePersistentState } from '../lib/ui.js'
import { SETUP_STEPS } from '../lib/setup-steps.js'
import { toast } from '../lib/toasts.js'
import { Icon, Wordmark } from './icons.js'
import { Button } from './common.js'
import { OAuthWaiting } from './oauth-wait.js'
import { CloudDrives, CloudReady, CloudSignIn, confirmCloudLogout } from './cloud.js'
import { cloudCancel, cloudRefresh } from '../lib/cloud.js'

function Steps({ current, done, onPick }) {
  return html`<ol class="steps" aria-label="Etapas">
    ${SETUP_STEPS.map((s, i) => {
      const state = done[i] ? 'done' : i === current ? 'now' : 'next'
      const reachable = i <= current || done[i - 1] || done[i]
      return html`<li class=${cx('step', `is-${state}`)}>
        <button type="button" class="step-btn" disabled=${!reachable} aria-current=${i === current ? 'step' : undefined} onClick=${() => onPick(i)}>
          <span class="step-dot">${state === 'done' ? html`<${Icon} name="check" size=${13} strokeWidth=${2.2} />` : i + 1}</span>
          <span class="step-label">${s.short}</span>
        </button>
      </li>`
    })}
  </ol>`
}

function StepKey({ step, onNext }) {
  const [ticked, setTicked] = usePersistentState('setup.ticked', {})
  return html`<div class="setup-step">
    <ol class="checklist">
      ${step.checklist.map((item, i) => {
        const on = !!ticked[i]
        return html`<li class=${cx('check-item', on && 'is-on')}>
          <button type="button" class="check-num" aria-pressed=${on ? 'true' : 'false'} title=${on ? 'Desmarcar' : 'Marcar como feito'} onClick=${() => setTicked((t) => ({ ...t, [i]: !t[i] }))}>
            ${on ? html`<${Icon} name="check" size=${13} strokeWidth=${2.2} />` : i + 1}
          </button>
          <div class="check-text">
            <b>${item.title}</b>
            <span>${item.detail}</span>
          </div>
          <a class="btn btn-secondary btn-sm" href=${item.href} target="_blank" rel="noopener noreferrer" onClick=${() => setTicked((t) => ({ ...t, [i]: true }))}>
            <span>${item.cta}</span><${Icon} name="external" size=${13} />
          </a>
        </li>`
      })}
    </ol>
    <div class="setup-actions">
      <span class="sub">Os links abrem o Console do Google numa aba nova.</span>
      <${Button} variant="primary" iconRight="arrow-right" onClick=${onNext}>${step.next}</${Button}>
    </div>
  </div>`
}

function StepPaste({ step, onDone, onBack, backLabel }) {
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [manual, setManual] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [fileName, setFileName] = useState(null)
  const input = useRef(null)

  const send = async (body) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/api/setup/credentials', body)
      setSetup(res.setup)
      toast('success', 'Chave salva neste computador.')
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // "Cole a chave" ao pé da letra: ⌘V/Ctrl+V com o conteúdo do JSON (ou o próprio arquivo copiado no Finder/Explorer).
  useEffect(() => {
    const onPaste = (e) => {
      const t = e.target
      if (t?.closest?.('input, textarea, [contenteditable="true"]')) return // colando no Client ID/secret
      const file = e.clipboardData?.files?.[0]
      if (file) {
        e.preventDefault()
        return readFile(file)
      }
      const text = (e.clipboardData?.getData('text') || '').trim()
      if (!text) return
      e.preventDefault()
      if (text.startsWith('{')) return send({ json: text })
      if (/\.apps\.googleusercontent\.com$/.test(text)) {
        setManual(true)
        setClientId(text)
        return
      }
      setError('Isso não parece a chave. Cole o conteúdo do arquivo JSON baixado do Console (começa com {"installed":…).')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  const readFile = (file) => {
    if (!file) return
    setFileName(file.name)
    if (file.size > 64 * 1024) {
      setError('Esse arquivo é grande demais para ser a chave. Procure o JSON baixado do Console (client_secret_….json).')
      return
    }
    const r = new FileReader()
    r.onload = () => send({ json: String(r.result || '') })
    r.onerror = () => setError('Não consegui ler esse arquivo.')
    r.readAsText(file)
  }

  return html`<div class="setup-step">
    <div
      class=${cx('dropzone', drag && 'is-drag', busy && 'is-busy', error && 'is-error')}
      role="button"
      tabindex="0"
      aria-label="Escolher o arquivo JSON da chave"
      onClick=${() => input.current?.click()}
      onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
      onDragOver=${(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => {
        e.preventDefault()
        setDrag(false)
        readFile(e.dataTransfer?.files?.[0])
      }}
    >
      <span class="dropzone-icon"><${Icon} name=${busy ? 'key' : 'drop'} size=${26} /></span>
      <b>${busy ? 'Conferindo a chave…' : fileName && !error ? fileName : step.drop.title}</b>
      <span class="sub">${step.drop.hint}</span>
      <span class="sub">${step.drop.paste.replace('{key}', getState().app?.platform === 'darwin' ? '⌘V' : 'Ctrl+V')}</span>
      <input ref=${input} type="file" accept=".json,application/json" hidden onChange=${(e) => readFile(e.currentTarget.files?.[0])} />
    </div>
    ${error ? html`<p class="form-error" role="alert"><${Icon} name="warning" size=${14} /> ${error}</p>` : null}

    <div class=${cx('manual', manual && 'is-open')}>
      <button type="button" class="manual-toggle" aria-expanded=${manual ? 'true' : 'false'} onClick=${() => setManual(!manual)}>
        <${Icon} name="chevron-right" size=${12} strokeWidth=${2} />${step.manual.toggle}
      </button>
      ${manual
        ? html`<form
            class="manual-form"
            onSubmit=${(e) => {
              e.preventDefault()
              send({ clientId: clientId.trim(), clientSecret: secret.trim() })
            }}
          >
            <label class="field">
              <span class="field-label">${step.manual.clientId}</span>
              <input class="input mono" type="text" value=${clientId} placeholder=${step.manual.clientIdPlaceholder} onInput=${(e) => setClientId(e.currentTarget.value)} spellcheck="false" autocomplete="off" />
            </label>
            <label class="field">
              <span class="field-label">${step.manual.clientSecret}</span>
              <input class="input mono" type="password" value=${secret} placeholder=${step.manual.clientSecretPlaceholder} onInput=${(e) => setSecret(e.currentTarget.value)} spellcheck="false" autocomplete="off" />
            </label>
            <div class="manual-actions">
              <${Button} type="submit" variant="primary" loading=${busy} disabled=${!clientId.trim() || !secret.trim()}>${step.manual.submit}</${Button}>
            </div>
          </form>`
        : null}
    </div>

    <div class="setup-actions">
      <button type="button" class="link" onClick=${onBack}><${Icon} name="arrow-left" size=${13} /> ${backLabel}</button>
    </div>
  </div>`
}

function StepConnect({ step, hint, onChangeKey }) {
  const waiting = useStore((s) => s.oauthWait)
  return html`<div class="setup-step">
    <div class="connect">
      ${waiting
        ? html`<${OAuthWaiting} />`
        : html`<a class="btn btn-primary btn-xl" href="/api/auth/start">
              <${Icon} name="user" size=${18} />
              <span>${step.button}</span>
            </a>
            ${hint ? html`<span class="sub">Chave <span class="mono-path">${hint}</span> · <button type="button" class="link" onClick=${onChangeKey}>trocar</button></span>` : null}`}
    </div>
    <aside class="callout">
      <span class="callout-icon"><${Icon} name="info" size=${16} /></span>
      <div>
        <b>${step.note.title}</b>
        <p>${step.note.body}</p>
        <div class="clicks" aria-hidden="true">
          ${step.note.clicks.map((c, i) => html`${i ? html`<${Icon} name="arrow-right" size=${13} />` : null}<span class="fake-link">${c}</span>`)}
        </div>
      </div>
    </aside>
  </div>`
}

/** Boas-vindas: entrar com a conta SOBEDESCE (o caminho principal). A chave própria do Google fica como alternativa. */
function CloudWelcome() {
  const cloud = useStore((s) => s.cloud)
  const setup = useStore((s) => s.setup)
  const signed = !!cloud?.conectado
  const contas = cloud?.contas || []
  const pending = cloud?.login?.estado === 'pendente'
  const user = cloud?.usuario || {}

  const begin = async () => {
    await cloudCancel() // limpa o "pronto" do login
    navigate('painel')
  }
  const localPath = () => (setup.configured ? (location.href = '/api/auth/start') : navigate('inicio/local'))

  let title = 'Entre na sua conta SOBEDESCE'
  let lead = 'Os Google Drives da sua conta aparecem aqui, prontos para enviar e baixar. Sem chave do Google, sem configuração.'
  if (pending) lead = 'Abrimos o navegador. Entre na sua conta e libere este computador com o código abaixo.'
  if (signed && contas.length) {
    title = 'Conta conectada'
    lead = 'Estes Drives já podem enviar e baixar neste computador.'
  } else if (signed) {
    title = 'Falta conectar um Drive'
    lead = 'Sua conta ainda não tem nenhum Google Drive. Conecte um no site e ele aparece aqui sozinho.'
  }

  return html`<div class="setup">
    <div class="setup-brand"><${Wordmark} size=${26} /></div>
    <main class="setup-card card welcome-card">
      <div class="setup-top"><span class="eyebrow">Primeiros passos</span></div>
      <h1 class="setup-title">${title}</h1>
      <p class="setup-lead">${lead}</p>
      ${signed
        ? html`<div class="setup-step">
            ${contas.length ? html`<${CloudReady} />` : null}
            <div class="sgroup-box welcome-drives"><${CloudDrives} accounts=${contas} /></div>
            <div class="setup-actions">
              <span class="sub">Conta ${user.email || user.nome || 'SOBEDESCE'} · <button type="button" class="link" onClick=${confirmCloudLogout}>Sair da conta</button></span>
              ${contas.length
                ? html`<${Button} variant="primary" iconRight="arrow-right" onClick=${begin}>Começar</${Button}>`
                : html`<${Button} icon="refresh" onClick=${() => cloudRefresh({ force: true })}>Atualizar</${Button}>`}
            </div>
          </div>`
        : html`<div class="welcome-signin"><${CloudSignIn} hero /></div>
            ${pending ? null : html`<div class="welcome-alt">
              <span class="welcome-or"><span>ou</span></span>
              <button type="button" class="btn btn-ghost btn-sm" onClick=${localPath}><${Icon} name="laptop" size=${15} /><span>Conectar um Drive só neste computador</span></button>
              <span class="sub">Com a sua própria chave do Google. Leva uns dez minutos.</span>
            </div>`}`}
    </main>
    <p class="setup-foot">Os arquivos vão direto deste computador para o Google. O site só guarda o acesso aos seus Drives.</p>
  </div>`
}

export function SetupScreen({ route }) {
  const sub = route?.parts[1]
  if (sub !== 'local' && sub !== 'chave') return html`<${CloudWelcome} />`
  return html`<${LocalSetup} route=${route} />`
}

/** Drive só neste computador: criar a chave no Google, colar, conectar (o caminho de antes da conta SOBEDESCE). */
function LocalSetup({ route }) {
  const setup = useStore((s) => s.setup)
  const accounts = useStore((s) => s.accounts)
  const changingKey = route?.name === 'inicio' && route.parts[1] === 'chave'
  const initial = changingKey ? 1 : setup.configured ? 2 : 0
  const [current, setCurrent] = useState(initial)

  useEffect(() => {
    if (changingKey) setCurrent(1)
  }, [changingKey])

  const done = [setup.configured || current > 0, setup.configured, accounts.length > 0]
  const step = SETUP_STEPS[current]

  const afterKey = () => {
    if (changingKey && accounts.length) navigate('ajustes')
    else setCurrent(2)
  }
  const back = accounts.length ? { label: 'Voltar para Ajustes', go: () => navigate('ajustes') } : { label: 'Entrar com a conta SOBEDESCE', go: () => navigate('inicio') }

  return html`<div class="setup">
    <div class="setup-brand"><${Wordmark} size=${26} /></div>
    <main class="setup-card card">
      <div class="setup-top">
        <span class="eyebrow">${changingKey && accounts.length ? 'Trocar chave' : 'Drive só neste computador'}</span>
        <${Steps} current=${current} done=${done} onPick=${setCurrent} />
      </div>
      <h1 class="setup-title">${step.title}</h1>
      <p class="setup-lead">${step.lead}</p>
      ${current === 0 ? html`<${StepKey} step=${step} onNext=${() => setCurrent(1)} />` : null}
      ${current === 1
        ? html`<${StepPaste}
            step=${step}
            onDone=${afterKey}
            onBack=${() => (changingKey && accounts.length ? navigate('ajustes') : setCurrent(0))}
            backLabel=${changingKey && accounts.length ? 'Voltar para Ajustes' : 'Como criar a chave'}
          />`
        : null}
      ${current === 2 ? html`<${StepConnect} step=${step} hint=${setup.clientIdHint} onChangeKey=${() => setCurrent(1)} />` : null}
    </main>
    <p class="setup-foot">
      Com a sua chave, tudo fica neste computador: nenhum servidor vê seus arquivos ou o acesso ao Drive.
      <button type="button" class="link" onClick=${back.go}><${Icon} name="arrow-left" size=${12} /> ${back.label}</button>
    </p>
  </div>`
}
