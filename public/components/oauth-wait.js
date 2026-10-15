// Desktop: o login do Google acontece no navegador do sistema. Enquanto isso, a janela espera com calma.
import { html } from '/vendor/preact-htm.js'
import { cancelOAuth, reopenOAuth } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Spinner } from './common.js'
import { Modal } from './modal.js'

/** Bloco usado no passo "Conectar" dos Primeiros passos e dentro da janela de espera. */
export function OAuthWaiting({ compact }) {
  return html`<div class=${compact ? 'oauth-wait is-compact' : 'oauth-wait'} role="status" aria-live="polite">
    <div class="oauth-wait-row">
      <${Spinner} size=${18} />
      <div class="oauth-wait-text">
        <b>Termine o login no navegador…</b>
        <span class="sub"><span class="oauth-arrow" aria-hidden="true">▸</span> voltamos aqui sozinhos assim que você autorizar</span>
      </div>
    </div>
    <div class="oauth-wait-actions">
      <button type="button" class="link" onClick=${reopenOAuth}>Abrir o navegador de novo</button>
      <span class="dot-sep"></span>
      <button type="button" class="link" onClick=${cancelOAuth}>Cancelar</button>
    </div>
  </div>`
}

export function OAuthWaitDialog() {
  return html`<${Modal}
    size="sm"
    class="dialog oauth-dialog"
    title="Conectar conta Google"
    icon=${html`<${Icon} name="external" size=${18} />`}
    onClose=${cancelOAuth}
    footer=${html`<${Button} onClick=${cancelOAuth}>Cancelar</${Button}><${Button} variant="primary" icon="external" onClick=${reopenOAuth}>Abrir de novo</${Button}>`}
  >
    <div class="oauth-dialog-body">
      <div class="oauth-wait-row">
        <${Spinner} size=${18} />
        <div class="oauth-wait-text">
          <b>Termine o login no navegador…</b>
          <span class="sub"><span class="oauth-arrow" aria-hidden="true">▸</span> voltamos aqui sozinhos assim que você autorizar</span>
        </div>
      </div>
      <p class="dialog-text">Se aparecer “O Google não verificou este app”, clique em “Avançado” e depois em “Acessar SOBEDESCE (não seguro)” — a chave é sua.</p>
    </div>
  </${Modal}>`
}
