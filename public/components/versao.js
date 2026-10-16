// Aviso "Nova versão do SOBEDESCE" na barra lateral, acima dos medidores. Não bloqueia nada: as transferências seguem.
// App instalado no Mac/Windows: "Atualizar" (o app se troca sozinho e abre de novo) com "Baixar" de alternativa.
import { html, useMemo } from '/vendor/preact-htm.js'
import { useStore, activeCount } from '../lib/store.js'
import { dismissUpdate, downloadUpdate, installHint, installUpdate, updateProgress, updating } from '../lib/versao.js'
import { Icon } from './icons.js'
import { Button } from './common.js'

/** Barra fina de progresso da atualização (sem medida = listras andando). */
export function UpdateBar({ fraction }) {
  const known = typeof fraction === 'number'
  return html`<div class=${known ? 'update-bar' : 'update-bar is-indeterminate'} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${known ? Math.round(fraction * 100) : undefined}>
    <span style=${known ? { width: `${(fraction * 100).toFixed(1)}%` } : undefined}></span>
  </div>`
}

export function UpdateCard() {
  const v = useStore((s) => s.versao)
  const transfers = useStore((s) => s.transfers)
  const busy = useMemo(() => activeCount(transfers) > 0, [transfers])
  const andando = updating(v)
  if (!v?.nova && !andando) return null
  const prog = updateProgress(v.atualizacao)
  return html`<section class="update-card" aria-labelledby="update-title" aria-busy=${andando ? 'true' : undefined}>
    <div class="update-head">
      <span class="update-mark" aria-hidden="true"><${Icon} name="arrow-down" size=${12} strokeWidth=${2.2} /></span>
      <b id="update-title">${andando ? 'Atualizando o SOBEDESCE' : 'Nova versão do SOBEDESCE'}</b>
    </div>
    ${andando
      ? html`<div class="update-progress" aria-live="polite">
          <${UpdateBar} fraction=${prog?.fraction} />
          <p>${prog?.label}</p>
        </div>`
      : html`<p>
            ${prog?.erro ? html`<span class="update-error">${prog.label}</span>` : installHint(v.plataforma, v.podeAtualizar)}
            ${busy && !prog?.erro
              ? html` <span class="update-busy">${v.podeAtualizar ? 'Atualizar pausa as transferências até o app voltar.' : 'Instale quando as transferências terminarem.'}</span>`
              : null}
          </p>
          <div class="update-actions">
            ${v.podeAtualizar
              ? html`<${Button} size="sm" variant="primary" onClick=${installUpdate}>${prog?.erro ? 'Tentar de novo' : 'Atualizar'}</${Button}>`
              : html`<${Button} size="sm" variant="primary" onClick=${downloadUpdate}>Baixar</${Button}>`}
            <${Button} size="sm" variant="ghost" onClick=${dismissUpdate}>Depois</${Button}>
          </div>
          ${v.podeAtualizar ? html`<button type="button" class="update-alt" onClick=${downloadUpdate}>Ou baixe o instalador</button>` : null}`}
  </section>`
}
