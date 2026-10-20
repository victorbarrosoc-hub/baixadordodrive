// Comparar → "Entre discos": passa um cartão ou SSD para um ou mais discos, comparando antes (o que é novo, o que já
// está lá, o que difere), com MD5 conferido, velocidade e tempo restante. Motor em src/discos/ (docs/DISCOS.md).
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { api, attempt, withQuery } from '../lib/api.js'
import { aprox, bytes, count, plural, speedParts, tildify, baseName } from '../lib/format.js'
import { cx, usePersistentState } from '../lib/ui.js'
import { bridge, pickFolderPath, revealLabel, revealPath } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Checkbox, EmptyState, Segmented, Spinner } from './common.js'
import { useLocalRoots } from './local-picker.js'

const ALGS = [
  { value: 'xxh64', label: 'xxHash64 · rápido' },
  { value: 'md5', label: 'MD5 · igual ao Drive' },
]

const ESTADOS = [
  { id: 'novo', label: 'Novos', tom: 'up', icon: 'plus' },
  { id: 'igual', label: 'Já estão lá', tom: 'ok', icon: 'check' },
  { id: 'diferente', label: 'Diferentes', tom: 'warn', icon: 'warning' },
]

/** ".../SSD Backup/Casamento/SOBEDESCE_copia_….md5" → "SSD Backup" (o destino escolhido). */
const discoDe = (arq) => arq.split(/[\\/]/).filter(Boolean).at(-3) || arq

export const duracao = (s) => {
  if (!Number.isFinite(s)) return '—'
  if (s < 60) return `${Math.max(1, Math.round(s))} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m < 60 ? `${m} min ${String(r).padStart(2, '0')} s` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

export function Velocidade({ bps, rotulo }) {
  const v = speedParts(bps)
  return html`<div class="dk-num">
    <span class="dk-num-v">${v.value}<small>${v.unit}</small></span>
    <span class="dk-num-l">${rotulo}</span>
  </div>`
}

/** Gráfico da velocidade nos últimos instantes (amostras guardadas pela tela). */
export function Grafico({ pontos }) {
  if (pontos.length < 2) return html`<div class="dk-graf is-vazio"></div>`
  const max = Math.max(...pontos, 1)
  const w = 300
  const h = 64
  const passo = w / (pontos.length - 1)
  const linha = pontos.map((v, i) => `${(i * passo).toFixed(1)},${(h - (v / max) * (h - 6) - 3).toFixed(1)}`).join(' ')
  return html`<svg class="dk-graf" viewBox=${`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
    <polygon class="dk-graf-area" points=${`0,${h} ${linha} ${w},${h}`} />
    <polyline class="dk-graf-linha" points=${linha} />
  </svg>`
}

function Lado({ titulo, icon, caminho, home, onTrocar, onTirar, vazio, tom }) {
  return html`<div class=${cx('dk-lado card', !caminho && 'is-vazio', tom && `is-${tom}`)}>
    <span class="dk-lado-icon"><${Icon} name=${icon} size=${18} /></span>
    <div class="dk-lado-txt">
      <span class="eyebrow">${titulo}</span>
      ${caminho
        ? html`<b title=${caminho}>${baseName(caminho) || caminho}</b><span class="mono-path" title=${caminho}>${tildify(caminho, home)}</span>`
        : html`<span class="sub">${vazio}</span>`}
    </div>
    <div class="dk-lado-acoes">
      <${Button} size="sm" icon="folder" onClick=${onTrocar}>${caminho ? 'Trocar' : 'Escolher'}</${Button}>
      ${onTirar ? html`<button type="button" class="icon-btn" onClick=${onTirar} aria-label="Tirar este destino"><${Icon} name="x" size=${14} /></button>` : null}
    </div>
  </div>`
}

function Espaco({ d, precisa }) {
  if (d.livre == null) return null
  const falta = precisa > d.livre
  const frac = d.livre > 0 ? Math.min(1, precisa / d.livre) : 1
  return html`<div class=${cx('dk-espaco', falta && 'is-falta')}>
    <div class="dk-espaco-bar"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></div>
    <span>${falta ? `Não cabe: precisa de ${bytes(precisa)}, tem ${bytes(d.livre)} livres` : `${bytes(precisa)} de ${bytes(d.livre)} livres`}</span>
  </div>`
}

function Lista({ destino, estado }) {
  const [dados, setDados] = useState(null)
  useEffect(() => {
    let vivo = true
    api.get(withQuery('/api/discos/itens', { destino, estado })).then((r) => vivo && setDados(r), () => vivo && setDados({ itens: [], total: 0 }))
    return () => (vivo = false)
  }, [destino, estado])
  if (!dados) return html`<div class="dk-lista is-carregando"><${Spinner} size=${16} /></div>`
  if (!dados.total) return html`<div class="dk-lista"><p class="sub dk-lista-vazia">Nenhum arquivo aqui.</p></div>`
  return html`<div class="dk-lista">
    <ul>
      ${dados.itens.map((it) => html`<li><span class="mono-path" title=${it.relPath}>${it.relPath}</span><span class="num sub">${bytes(it.size)}</span></li>`)}
    </ul>
    ${dados.total > dados.itens.length ? html`<p class="sub dk-lista-mais">e mais ${count(dados.total - dados.itens.length)}…</p>` : null}
  </div>`
}

function Plano({ v, opcoes, setOpcoes, onCopiar, copiando }) {
  const p = v.plano
  const [destino, setDestino] = useState(0)
  const [estado, setEstado] = useState('novo')
  const d = p.destinos[Math.min(destino, p.destinos.length - 1)]
  // Um arquivo é lido uma vez, mesmo indo para vários destinos: o botão mostra o destino que mais recebe.
  const total = useMemo(
    () => ({
      arquivos: p.destinos.reduce((m, x) => Math.max(m, x.novos + (opcoes.substituir ? x.diferentes : 0)), 0),
      bytes: p.destinos.reduce((m, x) => Math.max(m, x.bytesNovos + (opcoes.substituir ? x.bytesDiferentes : 0)), 0),
    }),
    [p, opcoes.substituir],
  )
  const conferirSo = opcoes.conferirIguais && p.destinos.some((x) => x.iguais)
  const falta = p.destinos.some((x) => x.livre != null && x.bytesNovos + (opcoes.substituir ? x.bytesDiferentes : 0) > x.livre)
  return html`<section class="card dk-plano">
    <header class="dk-plano-head">
      <div>
        <h2>${plural(p.origem.arquivos, 'arquivo', 'arquivos')} · ${bytes(p.origem.bytes)}</h2>
        <p class="sub">Vão para <b>${p.nome}</b> dentro de ${p.destinos.length === 1 ? 'cada destino' : `${p.destinos.length} destinos`}${v.plano.ignorados ? ` · ${v.plano.ignorados} sem permissão de leitura` : ''}</p>
      </div>
      ${p.destinos.length > 1
        ? html`<${Segmented} size="sm" label="Destino" value=${destino} onChange=${setDestino} options=${p.destinos.map((x, i) => ({ value: i, label: baseName(x.caminho) || x.caminho }))} />`
        : null}
    </header>
    <div class="dk-tiles">
      ${ESTADOS.map((e) => {
        const n = e.id === 'novo' ? d.novos : e.id === 'igual' ? d.iguais : d.diferentes
        const b = e.id === 'novo' ? d.bytesNovos : e.id === 'diferente' ? d.bytesDiferentes : null
        return html`<button type="button" class=${cx('dk-tile', `is-${e.tom}`, estado === e.id && 'is-on')} onClick=${() => setEstado(e.id)} aria-pressed=${estado === e.id ? 'true' : 'false'}>
          <span class="dk-tile-icon"><${Icon} name=${e.icon} size=${15} strokeWidth=${2} /></span>
          <span class="dk-tile-n num">${count(n)}</span>
          <span class="dk-tile-l">${e.label}${b ? html` · <span class="num">${bytes(b)}</span>` : null}</span>
        </button>`
      })}
    </div>
    <${Espaco} d=${d} precisa=${d.bytesNovos + (opcoes.substituir ? d.bytesDiferentes : 0)} />
    <${Lista} destino=${destino} estado=${estado} />
    <div class="dk-opcoes">
      <label class="dk-opcao"><${Checkbox} checked=${opcoes.conferir} onChange=${(on) => setOpcoes({ ...opcoes, conferir: on })} label="Conferir" /><span><b>Conferir cada arquivo copiado</b><span class="sub"> · lê o destino de novo e compara o checksum com a origem</span></span></label>
      ${p.destinos.some((x) => x.iguais)
        ? html`<label class="dk-opcao"><${Checkbox} checked=${opcoes.conferirIguais} onChange=${(on) => setOpcoes({ ...opcoes, conferirIguais: on })} label="Conferir os que já estão lá" /><span><b>Conferir também os que já estão no destino</b><span class="sub"> · compara o conteúdo, não só o tamanho; o que não bater é copiado de novo</span></span></label>`
        : null}
      <label class="dk-opcao"><${Checkbox} checked=${opcoes.relatorio} onChange=${(on) => setOpcoes({ ...opcoes, relatorio: on })} label="Relatório" /><span><b>Salvar o relatório de checksums no destino</b><span class="sub"> · para conferir de novo depois</span></span></label>
      <div class="dk-opcao dk-alg">
        <span class="sub">Checksum</span>
        <${Segmented} size="sm" label="Checksum" value=${opcoes.algoritmo || 'xxh64'} onChange=${(a) => setOpcoes({ ...opcoes, algoritmo: a })} options=${ALGS} />
        <span class="sub">${(opcoes.algoritmo || 'xxh64') === 'md5' ? 'o mesmo do Google Drive; mais lento em SSD rápido' : 'o padrão das ferramentas de offload de cinema; ~4 GB/s'}</span>
      </div>
      ${p.destinos.some((x) => x.diferentes)
        ? html`<label class="dk-opcao is-warn"><${Checkbox} checked=${opcoes.substituir} onChange=${(on) => setOpcoes({ ...opcoes, substituir: on })} label="Substituir" /><span><b>Substituir os diferentes</b><span class="sub"> · grava por cima dos que têm outro tamanho no destino</span></span></label>`
        : null}
    </div>
    <div class="dk-go">
      <${Button} variant="primary" size="lg" icon="copy" onClick=${onCopiar} loading=${copiando} disabled=${(!total.arquivos && !conferirSo) || falta}>
        ${total.arquivos ? `Copiar ${plural(total.arquivos, 'arquivo', 'arquivos')} · ${bytes(total.bytes)}` : conferirSo ? 'Conferir o que já está lá' : 'Nada para copiar'}
      </${Button}>
      ${!total.arquivos && !conferirSo ? html`<span class="sub">Tudo já está no destino. Marque “Conferir também os que já estão no destino” para checar o conteúdo.</span>` : null}
    </div>
  </section>`
}

function Andamento({ v, pontos, onCancelar }) {
  const g = v.progresso
  const frac = g.totalBytes ? (g.copiados + g.conferidos) / (g.totalBytes + g.totalConferir || 1) : 0
  const conferindo = g.etapa === 'conferindo' || (g.totalConferir && g.copiados >= g.totalBytes && g.conferidos < g.totalConferir)
  return html`<section class="card dk-andamento" aria-live="polite">
    <div class="dk-and-topo">
      <div class="dk-anel" style=${`--p:${(frac * 100).toFixed(1)}`}>
        <span class="num">${Math.floor(frac * 100)}<small>%</small></span>
      </div>
      <div class="dk-and-txt">
        <h2>${conferindo ? 'Conferindo…' : 'Copiando…'}</h2>
        <p class="sub num">${bytes(g.copiados)} de ${bytes(g.totalBytes)} · ${count(g.arquivos)} de ${plural(g.totalArquivos, 'arquivo', 'arquivos')}</p>
        ${g.atual ? html`<p class="mono-path dk-atual" title=${g.atual}>${g.atual}</p>` : null}
      </div>
      <${Button} variant="ghost" size="sm" icon="x" onClick=${onCancelar}>Parar</${Button}>
    </div>
    <div class="dk-nums">
      <${Velocidade} bps=${g.velocidade} rotulo="agora" />
      <${Velocidade} bps=${g.velocidadeMedia} rotulo="média" />
      <div class="dk-num"><span class="dk-num-v">${g.restante == null ? '—' : aprox(g.restante) || '—'}</span><span class="dk-num-l">faltam</span></div>
      <div class="dk-num"><span class="dk-num-v">${duracao(g.decorrido)}</span><span class="dk-num-l">passou</span></div>
    </div>
    <${Grafico} pontos=${pontos} />
    ${g.falhas ? html`<p class="dk-aviso"><${Icon} name="warning" size=${14} /> ${plural(g.falhas, 'arquivo com problema', 'arquivos com problema')} até agora (a lista sai no fim).</p>` : null}
  </section>`
}

function Resultado({ v, onDeNovo, onNova }) {
  const r = v.resultado
  const ok = !r.falhas.length && v.fase === 'feito'
  const media = r.segundos > 0 ? r.bytes / r.segundos : 0
  return html`<section class=${cx('card dk-fim', ok ? 'is-ok' : 'is-problema')}>
    <div class="dk-fim-topo">
      <span class="dk-fim-icon"><${Icon} name=${ok ? 'circle-check' : v.fase === 'cancelado' ? 'circle-x' : 'warning'} size=${26} /></span>
      <div>
        <h2>${v.fase === 'cancelado' ? 'Cópia parada' : ok ? (r.conferido ? 'Cópia conferida' : 'Cópia feita') : 'Cópia com problemas'}</h2>
        <p class="sub num">
          ${plural(r.copiados, 'arquivo', 'arquivos')} · ${bytes(r.bytes, { precise: true })} em ${duracao(r.segundos)}${media ? ` · média ${speedParts(media).value} ${speedParts(media).unit}` : ''}
        </p>
        ${r.erro ? html`<p class="dk-aviso">${r.erro}</p>` : null}
      </div>
    </div>
    ${r.cobertura?.length
      ? html`<ul class="dk-cobertura">
          ${r.cobertura.map((c) => {
            const completo = c.presentes === c.total
            return html`<li class=${cx(completo ? 'is-ok' : 'is-falta')}>
              <${Icon} name=${completo ? 'circle-check' : 'warning'} size=${16} />
              <b>${baseName(c.caminho) || c.caminho}</b>
              <span class="num">${completo ? `todos os ${count(c.total)} arquivos da origem estão aqui` : `${count(c.presentes)} de ${count(c.total)} arquivos · faltam ${count(c.total - c.presentes)}${c.diferentes ? ` (${plural(c.diferentes, 'está', 'estão')} com outro tamanho no destino: marque “Substituir os diferentes”)` : ''}`}</span>
              <span class="sub num">${count(c.conferidos)} conferidos pelo conteúdo (${(r.algoritmo || 'xxh64') === 'md5' ? 'MD5' : 'xxHash64'})</span>
            </li>`
          })}
        </ul>`
      : null}
    ${r.corrigidos ? html`<p class="dk-aviso"><${Icon} name="info" size=${14} /> ${plural(r.corrigidos, 'arquivo que já estava no destino estava diferente e foi copiado de novo', 'arquivos que já estavam no destino estavam diferentes e foram copiados de novo')}.</p>` : null}
    ${r.falhas.length
      ? html`<ul class="dk-falhas">
          ${r.falhas.slice(0, 100).map((f) => html`<li><span class="mono-path">${f.relPath}</span><span class="sub">${f.destino ? `${baseName(f.destino)}: ` : ''}${f.erro}</span></li>`)}
        </ul>`
      : null}
    ${r.relatorios.length
      ? html`<div class="dk-rel">
          ${r.relatorios.map((arq) => html`<button type="button" class="link-btn" onClick=${() => revealPath(arq)} title=${arq}><${Icon} name="doc" size=${14} /> Relatório de checksums em ${discoDe(arq)} · ${revealLabel()}</button>`)}
        </div>`
      : null}
    <div class="dk-go">
      <${Button} variant="primary" icon="compare" onClick=${onDeNovo}>Comparar de novo</${Button}>
      <${Button} onClick=${onNova}>Nova cópia</${Button}>
    </div>
  </section>`
}

export function DiscosPanel() {
  const v = useStore((s) => s.discos) || { fase: 'parado' }
  const roots = useLocalRoots()
  const [origem, setOrigem] = usePersistentState('discos.origem', null)
  const [destinos, setDestinos] = usePersistentState('discos.destinos', [null])
  const [nome, setNome] = usePersistentState('discos.nome', '')
  const [opcoes, setOpcoes] = usePersistentState('discos.opcoes', { conferir: true, conferirIguais: false, relatorio: true, substituir: false, algoritmo: 'xxh64' })
  const [ocupado, setOcupado] = useState(false)
  const [pontos, setPontos] = useState([])
  const avisado = useRef(null)

  // Velocidade dos últimos ~60 avisos, para o gráfico.
  useEffect(() => {
    if (v.fase !== 'copiando' || !v.progresso) return
    setPontos((p) => [...p.slice(-59), v.progresso.velocidade || 0])
  }, [v.progresso?.copiados, v.progresso?.conferidos])
  useEffect(() => {
    if (v.fase === 'copiando' && avisado.current === 'fim') {
      avisado.current = null
      setPontos([])
    }
    if ((v.fase === 'feito' || v.fase === 'erro') && v.resultado && avisado.current !== 'fim') {
      avisado.current = 'fim'
      const r = v.resultado
      if (bridge?.notify && !document.hasFocus()) bridge.notify(r.falhas.length ? 'Cópia com problemas' : 'Cópia conferida', `${count(r.copiados)} arquivos · ${bytes(r.bytes)}`)
    }
  }, [v.fase])

  const escolher = async (titulo, atual) => pickFolderPath({ title: titulo, defaultPath: atual || undefined })
  const comparar = async () => {
    const ds = destinos.filter(Boolean)
    if (!origem || !ds.length) return
    setOcupado(true)
    await attempt(api.post('/api/discos/planejar', { origem, destinos: ds, nome: nome.trim() || null }))
    setOcupado(false)
  }
  const copiar = async () => {
    setOcupado(true)
    setPontos([])
    await attempt(api.post('/api/discos/iniciar', opcoes))
    setOcupado(false)
  }
  const limpar = () => attempt(api.post('/api/discos/limpar', {}))
  const pronto = origem && destinos.some(Boolean)
  const nomeFinal = nome.trim() || (origem ? baseName(origem) : '')
  const travado = v.fase === 'copiando' || v.fase === 'planejando'

  return html`<div class="dk">
    <section class="dk-setup">
      <div class="dk-fluxo">
        <${Lado} titulo="Origem" icon="sdcard" caminho=${origem} home=${roots?.home} vazio="O cartão, o SSD ou a pasta" onTrocar=${async () => {
          const p = await escolher('De onde copiar?', origem)
          if (p) setOrigem(p)
        }} />
        <span class="dk-seta" aria-hidden="true"><${Icon} name="arrow-right" size=${18} /></span>
        <div class="dk-destinos">
          ${destinos.map(
            (d, i) => html`<${Lado}
              key=${i}
              titulo=${destinos.length > 1 ? `Destino ${i + 1}` : 'Destino'}
              icon="disk"
              tom="dest"
              caminho=${d}
              home=${roots?.home}
              vazio="O SSD ou a pasta do projeto"
              onTrocar=${async () => {
                const p = await escolher('Para onde copiar?', d)
                if (p) setDestinos(destinos.map((x, k) => (k === i ? p : x)))
              }}
              onTirar=${destinos.length > 1 ? () => setDestinos(destinos.filter((_, k) => k !== i)) : null}
            />`,
          )}
          ${destinos.length < 4 ? html`<button type="button" class="dk-mais" onClick=${() => setDestinos([...destinos, null])}><${Icon} name="plus" size=${14} /> Outro destino (backup)</button>` : null}
        </div>
      </div>
      <div class="dk-nome">
        <label for="dk-nome">Pasta no destino</label>
        <input id="dk-nome" class="input" type="text" maxlength="120" placeholder=${origem ? baseName(origem) : 'Nome da pasta'} value=${nome} onInput=${(e) => setNome(e.currentTarget.value)} />
        <span class="sub mono-path">${destinos.filter(Boolean).length ? `${baseName(destinos.find(Boolean))}/${nomeFinal || '…'}/` : 'Escolha o destino'}</span>
      </div>
      <div class="dk-go">
        <${Button} variant="primary" size="lg" icon="compare" onClick=${comparar} loading=${v.fase === 'planejando'} disabled=${!pronto || travado}>
          ${v.plano ? 'Comparar de novo' : 'Comparar'}
        </${Button}>
        <span class="sub">Primeiro compara: o que já está no destino não é copiado de novo.</span>
      </div>
    </section>

    ${v.fase === 'erro' && !v.resultado ? html`<section class="card cmp-error" role="alert"><${Icon} name="warning" size=${20} /><div><b>Não deu para comparar.</b><span class="sub">${v.erro}</span></div></section>` : null}
    ${v.fase === 'pronto' && v.plano ? html`<${Plano} v=${v} opcoes=${opcoes} setOpcoes=${setOpcoes} onCopiar=${copiar} copiando=${ocupado} />` : null}
    ${v.fase === 'copiando' && v.progresso ? html`<${Andamento} v=${v} pontos=${pontos} onCancelar=${() => attempt(api.post('/api/discos/cancelar', {}))} />` : null}
    ${v.resultado && ['feito', 'erro', 'cancelado'].includes(v.fase) ? html`<${Resultado} v=${v} onDeNovo=${comparar} onNova=${limpar} />` : null}
    ${v.fase === 'parado' || (!v.plano && v.fase !== 'erro' && v.fase !== 'planejando')
      ? html`<${EmptyState}
          compact
          art=${html`<div class="cmp-art" aria-hidden="true"><span class="src-icon dk-ic-org"><${Icon} name="sdcard" size=${20} /></span><span class="cmp-art-line"></span><span class="src-icon dk-ic-dest"><${Icon} name="disk" size=${20} /></span></div>`}
          title="De um disco para outro, conferido"
        >
          Escolha a origem e um ou mais destinos. O SOBEDESCE compara, copia só o que falta, confere cada arquivo e mostra a velocidade e quanto falta.
        </${EmptyState}>`
      : null}
  </div>`
}
