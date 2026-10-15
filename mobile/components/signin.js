// Entrar: um toque abre a janela do Google (modelo de token do GIS). O cliente de token é preparado antes,
// porque no iPhone o popup só abre se for pedido direto dentro do toque.
import { html, useEffect, useState } from '../vendor/preact-htm.js'
import * as auth from '../lib/auth.js'
import { setState, useApp } from '../lib/state.js'
import { Icon } from './icons.js'
import { Button, cx } from './ui.js'
import { InstallHint } from './install-hint.js'

export function SignInScreen() {
  const { clientId, authState } = useApp((s) => ({ clientId: s.clientId, authState: s.auth }))
  const [ready, setReady] = useState(auth.isReady())
  const [loadError, setLoadError] = useState(null)
  const [help, setHelp] = useState(false)
  const hint = auth.getHint()

  useEffect(() => {
    let alive = true
    setLoadError(null)
    auth.prepare(clientId).then(
      () => alive && setReady(true),
      (err) => alive && setLoadError(err.message || 'Não consegui carregar o login do Google.'),
    )
    return () => {
      alive = false
    }
  }, [clientId])

  const busy = authState.status === 'signingIn'
  const error = authState.error || loadError

  return html`<div class="screen signin">
    <main class="signin-main">
      <div class="signin-hero" aria-hidden="true">
        <span class="hero-bar hero-up"></span>
        <span class="hero-bar hero-down"></span>
      </div>
      <h1 class="title-xl signin-title"><span class="wordmark-text"><b>SOBE</b><span>DESCE</span></span></h1>
      <p class="lead signin-lead">Do celular direto para o seu Drive. Vídeos no tamanho original, sem passar por servidor nenhum.</p>

      <div class="signin-actions">
        <${Button} variant="primary" size="xl" class="btn-block" loading=${busy || (!ready && !loadError)} disabled=${busy || !ready} onClick=${() => auth.signIn()}>
          ${busy ? 'Esperando o Google…' : 'Entrar com Google'}
        </${Button}>
        ${hint && !busy ? html`<p class="sub signin-hint">como ${hint}</p>` : null}
        ${error ? html`<p class="form-error" role="alert"><${Icon} name="warning" size=${16} /> <span>${error}</span></p>` : null}
        ${loadError ? html`<${Button} variant="ghost" size="sm" icon="refresh" onClick=${() => location.reload()}>Tentar de novo</${Button}>` : null}
      </div>

      <div class=${cx('disclosure', help && 'is-open')}>
        <button type="button" class="disclosure-btn" aria-expanded=${help ? 'true' : 'false'} onClick=${() => setHelp(!help)}>
          <${Icon} name="chevron-right" size=${14} strokeWidth=${2} /> Problemas para entrar?
        </button>
        ${help
          ? html`<ul class="help-list">
              <li><b>“O Google não verificou este app”</b> É esperado: o app é seu. Toque em <i>Avançado</i> → <i>Acessar SOBEDESCE</i>.</li>
              <li><b>Erro 400 · origin_mismatch</b> Confira se <code>${location.origin}</code> está em Origens JavaScript autorizadas. Mudanças podem levar alguns minutos para valer.</li>
              <li><b>Erro 403 · access_denied</b> Adicione seu e-mail em Público-alvo → Usuários de teste (ou publique o app).</li>
              <li><b>Nada acontece</b> Libere pop-ups para este site e toque de novo.</li>
            </ul>`
          : null}
      </div>
    </main>
    <footer class="signin-foot">
      <p class="sub">Pedimos acesso ao Drive para enviar para qualquer pasta. O acesso fica só nesta aba.</p>
      <button type="button" class="link-btn" onClick=${() => setState({ screen: 'setup' })}>
        <${Icon} name="key" size=${15} /> Trocar ID do cliente
      </button>
    </footer>
    <${InstallHint} />
  </div>`
}
