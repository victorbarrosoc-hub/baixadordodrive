// Aviso "Nova versão do SOBEDESCE" na barra lateral, acima dos medidores. Não bloqueia nada: as transferências seguem.
import { html, useMemo } from '/vendor/preact-htm.js'
import { useStore, activeCount } from '../lib/store.js'
import { dismissUpdate, downloadUpdate, installHint } from '../lib/versao.js'
import { Icon } from './icons.js'
import { Button } from './common.js'

export function UpdateCard() {
  const v = useStore((s) => s.versao)
  const transfers = useStore((s) => s.transfers)
  const busy = useMemo(() => activeCount(transfers) > 0, [transfers])
  if (!v?.nova) return null
  return html`<section class="update-card" aria-labelledby="update-title">
    <div class="update-head">
      <span class="update-mark" aria-hidden="true"><${Icon} name="arrow-down" size=${12} strokeWidth=${2.2} /></span>
      <b id="update-title">Nova versão do SOBEDESCE</b>
    </div>
    <p>${installHint(v.plataforma)}${busy ? html` <span class="update-busy">Instale quando as transferências terminarem.</span>` : null}</p>
    <div class="update-actions">
      <${Button} size="sm" variant="primary" onClick=${downloadUpdate}>Baixar</${Button}>
      <${Button} size="sm" variant="ghost" onClick=${dismissUpdate}>Depois</${Button}>
    </div>
  </section>`
}
