// Dica de instalação no Safari do iPhone (só quando ainda não está na Tela de Início). Some ao fechar, e lembra.
import { html, useState } from '../vendor/preact-htm.js'
import { local } from '../lib/config.js'
import { isIOSSafari, isStandalone } from '../lib/platform.js'
import { Icon } from './icons.js'

const KEY = 'sobedesce.installHint'

export function InstallHint({ early = false }) {
  const [hidden, setHidden] = useState(() => !isIOSSafari || isStandalone() || local.get(KEY) === 'dismissed')
  if (hidden) return null
  const dismiss = () => {
    local.set(KEY, 'dismissed')
    setHidden(true)
  }
  return html`<aside class="install" role="note" aria-label="Instalar na Tela de Início">
    <span class="install-icon"><${Icon} name="share" size=${20} /></span>
    <p>
      ${early
        ? html`<b>Instale antes de entrar.</b> Toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>. O app instalado guarda o próprio login.`
        : html`<b>Deixe à mão.</b> Toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>.`}
    </p>
    <button type="button" class="install-x" onClick=${dismiss} aria-label="Fechar dica">
      <${Icon} name="x" size=${16} strokeWidth=${2} />
    </button>
  </aside>`
}
