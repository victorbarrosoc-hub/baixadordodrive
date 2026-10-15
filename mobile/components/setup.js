// Configurar: o celular usa um cliente OAuth do tipo "Aplicativo da Web" no MESMO projeto do Google Cloud do app
// do computador. Passos curtos com links diretos e o endereço deste site pronto para copiar.
import { html, useState } from '../vendor/preact-htm.js'
import { extractClientId, saveClientId } from '../lib/config.js'
import { getState, setState, toast } from '../lib/state.js'
import { Icon, Wordmark } from './icons.js'
import { Button, copyText, cx } from './ui.js'
import { InstallHint } from './install-hint.js'

const CLIENTS_URL = 'https://console.cloud.google.com/auth/clients'
const AUDIENCE_URL = 'https://console.cloud.google.com/auth/audience'

export function SetupScreen() {
  const current = getState().clientId
  const [value, setValue] = useState(current || '')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const origin = location.origin

  const copy = async () => {
    if (await copyText(origin)) {
      setCopied(true)
      toast('Endereço copiado', { tone: 'success' })
      setTimeout(() => setCopied(false), 2200)
    }
  }

  const submit = (e) => {
    e.preventDefault()
    const id = extractClientId(value)
    if (!id) {
      setError('Isso não parece um ID do cliente. Ele termina em .apps.googleusercontent.com.')
      return
    }
    saveClientId(id)
    setState({ clientId: id, screen: null, auth: { ...getState().auth, error: null } })
  }

  const canCancel = Boolean(current)

  return html`<div class="screen setup">
    <header class="screen-brand">
      <${Wordmark} size=${26} />
      ${canCancel ? html`<button type="button" class="link-btn" onClick=${() => setState({ screen: null })}>Cancelar</button>` : null}
    </header>

    <main class="setup-main">
      <p class="eyebrow">Primeiro acesso · uma vez só</p>
      <h1 class="title-xl">Ligue o celular ao seu projeto Google</h1>
      <p class="lead">
        Use o mesmo projeto do Google Cloud do app do computador. Lá, crie uma chave para a web — leva um minuto.
      </p>

      <ol class="group steps" aria-label="Passos no Console do Google">
        <li class="step">
          <span class="step-num" aria-hidden="true">1</span>
          <div class="step-body">
            <b>Abra Clientes no Console do Google</b>
            <span class="sub">Com o projeto do SOBEDESCE selecionado.</span>
          </div>
          <a class="btn btn-secondary btn-sm" href=${CLIENTS_URL} target="_blank" rel="noopener noreferrer">
            <span>Abrir</span><${Icon} name="external" size=${14} />
          </a>
        </li>
        <li class="step">
          <span class="step-num" aria-hidden="true">2</span>
          <div class="step-body">
            <b>Criar cliente → Aplicativo da Web</b>
            <span class="sub">Em “Tipo de aplicativo”. O nome pode ser SOBEDESCE Celular.</span>
          </div>
        </li>
        <li class="step step-wide">
          <span class="step-num" aria-hidden="true">3</span>
          <div class="step-body">
            <b>Em Origens JavaScript autorizadas, adicione</b>
            <div class="origin">
              <code class="origin-url">${origin}</code>
              <button type="button" class=${cx('origin-copy', copied && 'is-done')} onClick=${copy}>
                <${Icon} name=${copied ? 'check' : 'copy'} size=${16} strokeWidth=${copied ? 2.2 : 1.6} />
                <span>${copied ? 'Copiado' : 'Copiar endereço'}</span>
              </button>
            </div>
            <span class="sub">Sem barra no fim. “URIs de redirecionamento” pode ficar vazio.</span>
          </div>
        </li>
        <li class="step">
          <span class="step-num" aria-hidden="true">4</span>
          <div class="step-body">
            <b>Toque em Criar e copie o ID do cliente</b>
            <span class="sub">Não precisa da chave secreta.</span>
          </div>
        </li>
      </ol>

      <form class="group field-card" onSubmit=${submit} novalidate>
        <label class="field">
          <span class="field-label">ID do cliente</span>
          <input
            class=${cx('input', error && 'is-error')}
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="Termina em .apps.googleusercontent.com"
            value=${value}
            aria-invalid=${error ? 'true' : 'false'}
            aria-describedby="client-help"
            onInput=${(e) => {
              setValue(e.currentTarget.value)
              if (error) setError(null)
            }}
          />
        </label>
        <p id="client-help" class=${cx('field-help', error && 'is-error')} role=${error ? 'alert' : undefined}>
          ${error || 'Fica guardado só neste aparelho.'}
        </p>
        <${Button} variant="primary" size="lg" type="submit" class="btn-block" disabled=${!value.trim()}>Continuar</${Button}>
      </form>

      <aside class="callout">
        <span class="callout-icon"><${Icon} name="users" size=${18} /></span>
        <div>
          <b>Sua conta precisa ter acesso</b>
          <p>
            Igual ao app do computador: seu e-mail em Público-alvo → Usuários de teste, ou o app publicado.
            Se você já usa o SOBEDESCE no computador, isso já está feito.
          </p>
          <a class="link" href=${AUDIENCE_URL} target="_blank" rel="noopener noreferrer">Abrir Público-alvo <${Icon} name="external" size=${13} /></a>
        </div>
      </aside>

      <p class="foot">Nada passa por servidor nosso: os arquivos vão direto do celular para o Google.</p>
    </main>
    <${InstallHint} early />
  </div>`
}
