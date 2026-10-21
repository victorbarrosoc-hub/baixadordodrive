// Comparar → "Entre discos": passa um cartão ou SSD para um ou mais discos, comparando antes (o que é novo, o que já
// está lá, o que difere), com o checksum conferido, velocidade e tempo restante. Motor em src/discos/ (docs/DISCOS.md).
// Visual no padrão do kit (docs/UI-KIT.md): passos numerados, resumo colorido ao lado e o botão grande.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { api, attempt, withQuery } from '../lib/api.js'
import { aprox, bytes, count, plural, speedParts, tildify, baseName } from '../lib/format.js'
import { cx, usePersistentState } from '../lib/ui.js'
import { bridge, pickFolderPath, revealLabel, revealPath } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Spinner, Switch } from './common.js'
import { Barra, BotaoGrande, Destaque, GraficoVelocidade, Linha, Linhas, Opcoes, Pagina, Passo, Pilulas, Resumo } from './kit.js'
import { useLocalRoots } from './local-picker.js'
import { Fonte, Rota } from './comparar-partes.js'

const ALGS = [
  { value: 'xxh64', titulo: 'xxHash64', sub: 'Rápido: o padrão do offload de cinema (~4 GB/s)', icone: 'bolt' },
  { value: 'md5', titulo: 'MD5', sub: 'O mesmo do Google Drive; mais lento em SSD rápido', icone: 'shield' },
]

const ESTADOS = [
  { id: 'novo', label: 'Novos', tom: 'up', icon: 'plus' },
  { id: 'igual', label: 'Já estão lá', tom: 'ok', icon: 'check' },
  { id: 'outro', label: 'Em outra pasta', tom: 'down', icon: 'folder' },
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

// Usados também na tela Computadores (components/computadores.js).
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

function Espaco({ d, precisa }) {
  if (d.livre == null) return null
  const falta = precisa > d.livre
  const frac = d.livre > 0 ? Math.min(1, precisa / d.livre) : 1
  return html`<div class=${cx('cp-espaco', falta && 'is-falta')}>
    <div class="cp-espaco-tit">
      <span class="k-rot">Espaço em ${baseName(d.caminho) || d.caminho}</span>
      <span class="num">${falta ? `Não cabe: precisa de ${bytes(precisa)}, tem ${bytes(d.livre)} livres` : `${bytes(precisa)} de ${bytes(d.livre)} livres`}</span>
    </div>
    <${Barra} p=${frac} tom=${falta ? 'erro' : null} label="Espaço livre usado pela cópia" />
  </div>`
}

function Lista({ destino, estado, juntar = true }) {
  const [dados, setDados] = useState(null)
  useEffect(() => {
    let vivo = true
    api.get(withQuery('/api/discos/itens', { destino, estado })).then((r) => vivo && setDados(r), () => vivo && setDados({ itens: [], total: 0 }))
    return () => (vivo = false)
  }, [destino, estado])
  if (!dados) return html`<div class="cp-lista is-carregando"><${Spinner} size=${16} /></div>`
  if (!dados.total) return html`<div class="cp-lista"><p class="k-nota">Nenhum arquivo aqui.</p></div>`
  return html`<div class="cp-lista">
    <ul>
      ${dados.itens.map(
        (it) => html`<li>
          <span class="cp-item-nome">
            <span class="mono-path" title=${it.relPath}>${it.relPath}</span>
            ${it.achado ? html`<span class="cp-achado" title=${it.achado}><${Icon} name="folder" size=${12} /> já está em ${tildify(it.achado)}</span>` : null}
            ${it.para && juntar && it.estados[destino] === 'novo' ? html`<span class="cp-achado" title=${it.para}><${Icon} name="folder" size=${12} /> vai para junto dos outros: ${tildify(it.para)}</span>` : null}
          </span>
          <span class="num sub">${bytes(it.size)}</span>
        </li>`,
      )}
    </ul>
    ${dados.total > dados.itens.length ? html`<p class="k-nota cp-lista-mais">e mais ${count(dados.total - dados.itens.length)}…</p>` : null}
  </div>`
}

/** O que a cópia vai fazer com as opções atuais (o botão mostra o destino que mais recebe). */
function totalDoPlano(p, opcoes) {
  const arquivos = p.destinos.reduce((m, x) => Math.max(m, x.novos + (opcoes.substituir ? x.diferentes : 0)), 0)
  const bytesT = p.destinos.reduce((m, x) => Math.max(m, x.bytesNovos + (opcoes.substituir ? x.bytesDiferentes : 0)), 0)
  const conferirSo = opcoes.conferirIguais && p.destinos.some((x) => x.iguais || x.emOutro)
  const falta = p.destinos.some((x) => x.livre != null && x.bytesNovos + (opcoes.substituir ? x.bytesDiferentes : 0) > x.livre)
  return { arquivos, bytes: bytesT, conferirSo, falta }
}

function Plano({ v, opcoes, setOpcoes }) {
  const p = v.plano
  const [destino, setDestino] = useState(0)
  const [estado, setEstado] = useState('novo')
  const d = p.destinos[Math.min(destino, p.destinos.length - 1)]
  return html`<${Passo}
    id="cp-resultado"
    icone="compare"
    cor="up"
    titulo="O que vai ser copiado"
    sub=${`${plural(p.origem.arquivos, 'arquivo', 'arquivos')} · ${bytes(p.origem.bytes)}`}
    frase=${html`Vão para <b>${p.nome}</b> dentro de ${p.destinos.length === 1 ? 'cada destino' : `${p.destinos.length} destinos`}${p.ignorados ? ` · ${p.ignorados} sem permissão de leitura` : ''}`}
    i=${5}
  >
    ${p.destinos.length > 1
      ? html`<${Pilulas} label="Destino" valor=${destino} onEscolher=${setDestino} itens=${p.destinos.map((x, i) => ({ value: i, label: baseName(x.caminho) || x.caminho }))} />`
      : null}
    <div class="k-stats cp-stats" style=${`--n:${p.destinos.some((x) => x.emOutro) ? 4 : 3}`}>
      ${ESTADOS.filter((e) => e.id !== 'outro' || p.destinos.some((x) => x.emOutro)).map((e) => {
        const n = e.id === 'novo' ? d.novos : e.id === 'igual' ? d.iguais : e.id === 'outro' ? d.emOutro || 0 : d.diferentes
        const b = e.id === 'novo' ? d.bytesNovos : e.id === 'diferente' ? d.bytesDiferentes : e.id === 'outro' ? d.bytesEmOutro : null
        return html`<button type="button" class=${cx('k-stat cp-stat', `is-${e.tom}`, estado === e.id && 'is-on', !n && 'is-zero')} onClick=${() => setEstado(e.id)} aria-pressed=${estado === e.id ? 'true' : 'false'}>
          <span class="k-stat-ic"><${Icon} name=${e.icon} size=${15} strokeWidth=${2} /></span>
          <b class="num">${count(n)}</b>
          <span>${e.label}${b ? html` · <span class="num">${bytes(b)}</span>` : null}</span>
        </button>`
      })}
    </div>
    ${d.emOutro
      ? html`<p class="k-nota cp-outro"><${Icon} name="folder" size=${14} /> ${plural(d.emOutro, 'arquivo já está', 'arquivos já estão')} nesta mídia em outra pasta (mesmo nome e tamanho). Não ${d.emOutro === 1 ? 'é copiado' : 'são copiados'} de novo.</p>`
      : null}
    <${Espaco} d=${d} precisa=${d.bytesNovos + (opcoes.substituir ? d.bytesDiferentes : 0)} />
    <${Lista} destino=${destino} estado=${estado} juntar=${opcoes.juntar !== false} />
    ${p.destinos.some((x) => x.iguais || x.emOutro) || p.destinos.some((x) => x.diferentes) || p.destinos.some((x) => x.juntos)
      ? html`<${Linhas}>
          ${p.destinos.some((x) => x.juntos)
            ? html`<${Linha}
                titulo="Pôr os novos junto dos que já estão lá"
                sub=${`${plural(d.juntos || 0, 'arquivo novo tem', 'arquivos novos têm')} os vizinhos em outra pasta desta mídia (ex.: o C055 vai para onde estão o C054 e o C056). Desligado, vai tudo para “${p.nome}”.`}
              >
                <${Switch} checked=${opcoes.juntar !== false} label="Pôr os novos junto dos que já estão lá" onChange=${(on) => setOpcoes({ ...opcoes, juntar: on })} />
              </${Linha}>`
            : null}
          ${p.destinos.some((x) => x.iguais || x.emOutro)
            ? html`<${Linha}
                titulo="Conferir também os que já estão no destino"
                sub=${`Compara o conteúdo, não só o tamanho: lê de novo ${bytes(Math.max(...p.destinos.map((x) => (x.bytesIguais || 0) + (x.bytesEmOutro || 0))))} nos dois discos, depois de copiar os novos. Mais seguro, bem mais demorado.`}
              >
                <${Switch} checked=${opcoes.conferirIguais} label="Conferir os que já estão lá" onChange=${(on) => setOpcoes({ ...opcoes, conferirIguais: on })} />
              </${Linha}>`
            : null}
          ${p.destinos.some((x) => x.diferentes)
            ? html`<${Linha} titulo="Substituir os diferentes" sub="Grava por cima dos que têm outro tamanho no destino.">
                <${Switch} checked=${opcoes.substituir} label="Substituir os diferentes" onChange=${(on) => setOpcoes({ ...opcoes, substituir: on })} />
              </${Linha}>`
            : null}
        </${Linhas}>`
      : null}
  </${Passo}>`
}

function Andamento({ v, pontos, onCancelar }) {
  const g = v.progresso
  const conferindo = g.etapa === 'conferindo' || g.soConferindo || (g.totalConferir && g.copiados >= g.totalBytes && g.conferidos < g.totalConferir)
  const agora = speedParts(g.velocidade)
  const media = speedParts(g.velocidadeMedia)
  return html`<${Passo}
    id="cp-resultado"
    icone="copy"
    cor="up"
    titulo=${g.soConferindo && g.copiados >= g.totalBytes ? 'Conferindo o que já estava lá' : conferindo ? 'Conferindo' : 'Copiando'}
    sub=${`${count(g.arquivos)} de ${plural(g.totalArquivos, 'arquivo', 'arquivos')}`}
    frase=${g.atual ? html`<span class="mono-path cp-atual" title=${g.atual}>${g.atual}</span>` : 'Começando…'}
    i=${5}
    acao=${html`<${Button} size="sm" icon="x" onClick=${onCancelar}>Parar</${Button}>`}
  >
    <div class="k-stats" style="--n:4" aria-live="polite">
      <div class="k-stat is-up"><span class="k-stat-ic"><${Icon} name="gauge" size=${15} strokeWidth=${1.9} /></span><b class="num">${agora.value}<small> ${agora.unit}</small></b><span>agora</span></div>
      <div class="k-stat"><span class="k-stat-ic"><${Icon} name="bolt" size=${15} strokeWidth=${1.9} /></span><b class="num">${media.value}<small> ${media.unit}</small></b><span>média</span></div>
      <div class="k-stat is-neutro"><span class="k-stat-ic"><${Icon} name="clock" size=${15} strokeWidth=${1.9} /></span><b class="num">${g.restante == null ? '—' : aprox(g.restante) || '—'}</b><span>faltam</span></div>
      <div class="k-stat is-neutro"><span class="k-stat-ic"><${Icon} name="refresh" size=${15} strokeWidth=${1.9} /></span><b class="num">${duracao(g.decorrido)}</b><span>passou</span></div>
    </div>
    ${pontos.length > 1 ? html`<div class="cp-grafico"><${GraficoVelocidade} pontos=${pontos.map((x) => ({ up: x }))} altura=${110} label="Velocidade da cópia" /></div>` : null}
    ${g.falhas ? html`<p class="k-nota cp-aviso"><${Icon} name="warning" size=${14} /> ${plural(g.falhas, 'arquivo com problema', 'arquivos com problema')} até agora (a lista sai no fim).</p>` : null}
  </${Passo}>`
}

function Resultado({ v }) {
  const r = v.resultado
  const ok = !r.falhas.length && v.fase === 'feito'
  const media = r.segundos > 0 ? r.bytes / r.segundos : 0
  return html`<${Passo}
    id="cp-resultado"
    icone=${ok ? 'circle-check' : v.fase === 'cancelado' ? 'circle-x' : 'warning'}
    cor=${ok ? 'ok' : v.fase === 'cancelado' ? 'warn' : 'err'}
    titulo=${v.fase === 'cancelado' ? 'Cópia parada' : ok ? (r.conferido ? 'Cópia conferida' : 'Cópia feita') : 'Cópia com problemas'}
    frase=${`${plural(r.copiados, 'arquivo', 'arquivos')} · ${bytes(r.bytes, { precise: true })} em ${duracao(r.segundos)}${media ? ` · média ${speedParts(media).value} ${speedParts(media).unit}` : ''}`}
    i=${5}
  >
    ${r.erro ? html`<p class="k-nota cp-aviso">${r.erro}</p>` : null}
    ${r.cobertura?.length
      ? html`<div class="k-itens">
          ${r.cobertura.map((c) => {
            const completo = c.presentes === c.total
            return html`<div class="k-item" style=${`--c:var(--${completo ? 'ok' : 'warn'})`}>
              <span class="k-item-ic"><${Icon} name=${completo ? 'circle-check' : 'warning'} size=${19} strokeWidth=${1.8} /></span>
              <span class="k-item-txt">
                <b>${baseName(c.caminho) || c.caminho}</b>
                <span>${completo ? `Todos os ${count(c.total)} arquivos da origem estão aqui` : `${count(c.presentes)} de ${count(c.total)} arquivos · faltam ${count(c.total - c.presentes)}${c.diferentes ? ` (${plural(c.diferentes, 'está', 'estão')} com outro tamanho no destino: ligue “Substituir os diferentes”)` : ''}`}</span>
                <span>${count(c.conferidos)} conferidos pelo conteúdo (${(r.algoritmo || 'xxh64') === 'md5' ? 'MD5' : 'xxHash64'})</span>
              </span>
              <span class="k-item-fim"><${Barra} p=${c.total ? c.presentes / c.total : 1} tom=${completo ? 'ok' : null} label="Arquivos da origem no destino" /></span>
            </div>`
          })}
        </div>`
      : null}
    ${r.corrigidos ? html`<p class="k-nota"><${Icon} name="info" size=${14} /> ${plural(r.corrigidos, 'arquivo que já estava no destino estava diferente e foi copiado de novo', 'arquivos que já estavam no destino estavam diferentes e foram copiados de novo')}.</p>` : null}
    ${r.falhas.length
      ? html`<ul class="cp-falhas">
          ${r.falhas.slice(0, 100).map((f) => html`<li><span class="mono-path">${f.relPath}</span><span class="sub">${f.destino ? `${baseName(f.destino)}: ` : ''}${f.erro}</span></li>`)}
        </ul>`
      : null}
    ${r.relatorios.length
      ? html`<div class="cp-rel">
          ${r.relatorios.map((arq) => html`<button type="button" class="link-btn" onClick=${() => revealPath(arq)} title=${arq}><${Icon} name="doc" size=${14} /> Relatório de checksums em ${discoDe(arq)} · ${revealLabel()}</button>`)}
        </div>`
      : null}
  </${Passo}>`
}

export function DiscosPanel({ topo }) {
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

  // Plano, cópia e resultado aparecem embaixo dos passos: quando mudam, a tela rola até eles.
  const fasePrincipal = ['pronto', 'copiando', 'feito', 'erro', 'cancelado'].includes(v.fase) ? v.fase : null
  const fasePassada = useRef(v.fase)
  useEffect(() => {
    const antes = fasePassada.current
    fasePassada.current = v.fase
    if (fasePrincipal && antes !== v.fase && antes !== 'parado') requestAnimationFrame(() => document.getElementById('cp-resultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
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
  // Cancelar: para a comparação ou a cópia de verdade no motor (a cópia apaga o arquivo pela metade).
  const cancelar = () => attempt(api.post('/api/discos/cancelar', {}))
  // Limpar: tira o plano/resultado do motor e as pastas escolhidas; volta ao passo 1 vazio.
  const limpar = async () => {
    setOrigem(null)
    setDestinos([null])
    setNome('')
    setPontos([])
    requestAnimationFrame(() => document.querySelector('.page-compare')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    await attempt(api.post('/api/discos/limpar', {}))
  }
  const pronto = origem && destinos.some(Boolean)
  const nomeFinal = nome.trim() || (origem ? baseName(origem) : '')
  const travado = v.fase === 'copiando' || v.fase === 'planejando'
  const comResultado = v.resultado && ['feito', 'erro', 'cancelado'].includes(v.fase)
  const canceladoAntes = v.fase === 'cancelado' && !v.resultado
  const total = v.fase === 'pronto' && v.plano ? totalDoPlano(v.plano, opcoes) : null
  const nomesDestinos = destinos.map((d) => (d ? baseName(d) || d : null))

  // ── coluna da direita ──
  let destaque = null
  if (v.fase === 'planejando') destaque = html`<${Destaque} titulo="Comparando" linha="Lendo a origem e os destinos" progresso=${null} vivo />`
  else if (v.fase === 'copiando' && v.progresso) {
    const g = v.progresso
    const frac = g.totalBytes ? (g.copiados + g.conferidos) / (g.totalBytes + g.totalConferir || 1) : 0
    // Copiou tudo o que faltava e agora só confere o que já estava lá: a linha diz isso, não "0 B de …".
    const conferindoIguais = g.soConferindo && g.copiados >= g.totalBytes
    destaque = html`<${Destaque}
      titulo=${conferindoIguais ? 'Conferindo o que já estava lá' : g.etapa === 'conferindo' ? 'Conferindo' : 'Copiando'}
      numero=${Math.floor(frac * 100)}
      unidade="%"
      progresso=${frac}
      linha=${conferindoIguais ? `Novos: ${bytes(g.copiados)} copiados · conferidos ${bytes(g.conferidos)} de ${bytes(g.totalConferir)}` : `${bytes(g.copiados)} de ${bytes(g.totalBytes)} copiados`}
      vivo
    />`
  } else if (total) {
    destaque = total.arquivos
      ? html`<${Destaque} titulo="Vai copiar" numero=${count(total.arquivos)} unidade=${total.arquivos === 1 ? 'arquivo' : 'arquivos'} linha=${total.falta ? 'Não cabe em um dos destinos' : bytes(total.bytes)} tom=${total.falta ? 'erro' : 'grad'} />`
      : html`<${Destaque} tom="ok" titulo="Tudo já está lá" numero=${count(v.plano.origem.arquivos)} unidade=${v.plano.origem.arquivos === 1 ? 'arquivo' : 'arquivos'} linha="Nada para copiar" />`
  } else if (comResultado) {
    const r = v.resultado
    const ok = !r.falhas.length && v.fase === 'feito'
    destaque = html`<${Destaque} tom=${ok ? 'ok' : 'erro'} titulo=${v.fase === 'cancelado' ? 'Cópia parada' : ok ? 'Conferida' : 'Com problemas'} numero=${count(r.copiados)} unidade=${r.copiados === 1 ? 'arquivo copiado' : 'arquivos copiados'} linha=${`${bytes(r.bytes)} em ${duracao(r.segundos)}`} />`
  } else if (canceladoAntes) destaque = html`<${Destaque} tom="erro" titulo="Cancelada" linha="A comparação parou no meio. Compare de novo quando quiser." />`

  const dicaComparar = !origem ? 'Falta escolher a origem' : !destinos.some(Boolean) ? 'Falta escolher o destino' : 'Primeiro compara: o que já está no destino não é copiado de novo'
  let botao
  if (v.fase === 'copiando') botao = html`<${Button} icon="x" onClick=${cancelar} class="cp-lado-btn">Parar a cópia</${Button}>`
  else if (v.fase === 'planejando') {
    botao = html`<${BotaoGrande} icone="compare" disabled dica="Comparando…">Comparando…</${BotaoGrande}>
      <${Button} icon="x" onClick=${cancelar} class="cp-lado-btn">Cancelar a comparação</${Button}>`
  } else if (total) {
    const rotulo = total.arquivos ? `Copiar ${plural(total.arquivos, 'arquivo', 'arquivos')}` : total.conferirSo ? 'Conferir o que já está lá' : 'Nada para copiar'
    const dica = total.falta
      ? 'Libere espaço ou tire o destino que não cabe'
      : total.arquivos
        ? html`<b>${bytes(total.bytes)}</b>${opcoes.conferir ? ' · cada arquivo conferido depois' : ''}`
        : total.conferirSo
          ? 'Lê o destino e compara o conteúdo'
          : 'Ligue “Conferir também os que já estão no destino” para checar o conteúdo'
    botao = html`<${BotaoGrande} icone="copy" onClick=${copiar} disabled=${ocupado || (!total.arquivos && !total.conferirSo) || total.falta} dica=${dica}>${rotulo}</${BotaoGrande}>
      <${Button} icon="compare" onClick=${comparar} disabled=${ocupado} class="cp-lado-btn">Comparar de novo</${Button}>`
  } else {
    botao = html`<${BotaoGrande} icone="compare" onClick=${comparar} disabled=${!pronto || travado || ocupado} dica=${dicaComparar}>${comResultado || canceladoAntes ? 'Comparar de novo' : 'Comparar'}</${BotaoGrande}>`
  }
  const podeLimpar = !travado && (origem || destinos.some(Boolean) || nome || v.plano || v.resultado || v.fase !== 'parado')

  const lado = html`<${Resumo} titulo=${v.fase === 'copiando' || v.fase === 'planejando' ? 'Agora' : comResultado ? 'Resultado' : 'O que vai acontecer'}>
      ${destaque}
      <${Rota} de=${origem ? baseName(origem) || origem : null} para=${nomesDestinos} deIcone="sdcard" paraIcone="disk" paraTom="up" />
      ${!destaque ? html`<p class="cp-resumo-txt">Compara antes, copia só o que falta e confere cada arquivo pelo conteúdo.</p>` : null}
    </${Resumo}>
    ${botao}
    ${podeLimpar ? html`<${Button} icon="trash" onClick=${limpar} class="cp-lado-btn">Limpar comparação</${Button}>` : null}`

  return html`<${Pagina}
    titulo="Comparar"
    frase="Passe um cartão ou SSD para outro disco: compara, copia o que falta e confere."
    class=${cx('page-compare', v.fase !== 'parado' && 'cp-lado-antes')}
    lado=${lado}
  >
    ${topo}
    <${Passo} n="1" titulo="De onde" sub="origem" frase="O cartão, o SSD ou a pasta." i=${2}>
      <${Fonte}
        icone="sdcard"
        tom="down"
        valor=${origem ? baseName(origem) || origem : null}
        caminho=${origem ? tildify(origem, roots?.home) : ''}
        vazio="Escolher a origem"
        dica="O cartão, o SSD ou a pasta"
        onTrocar=${async () => {
          const p = await escolher('De onde copiar?', origem)
          if (p) setOrigem(p)
        }}
        onSoltarPasta=${travado ? null : setOrigem}
        onTirar=${origem && !travado ? () => setOrigem(null) : null}
        tirarLabel="Tirar a origem"
      />
    </${Passo}>

    <${Passo} n="2" titulo="Para onde" sub=${destinos.length > 1 ? `${destinos.length} destinos` : 'destino'} frase="Um ou mais discos. Com dois, você já sai com o backup." i=${3}>
      <div class="cp-destinos">
        ${destinos.map(
          (d, i) => html`<${Fonte}
            key=${i}
            icone="disk"
            tom="up"
            rotulo=${destinos.length > 1 ? `Destino ${i + 1}` : null}
            valor=${d ? baseName(d) || d : null}
            caminho=${d ? tildify(d, roots?.home) : ''}
            vazio=${destinos.length > 1 ? `Escolher o destino ${i + 1}` : 'Escolher o destino'}
            dica="O SSD ou a pasta do projeto"
            onTrocar=${async () => {
              const p = await escolher('Para onde copiar?', d)
              if (p) setDestinos(destinos.map((x, k) => (k === i ? p : x)))
            }}
            onSoltarPasta=${travado ? null : (p) => setDestinos(destinos.map((x, k) => (k === i ? p : x)))}
            onTirar=${travado ? null : destinos.length > 1 ? () => setDestinos(destinos.filter((_, k) => k !== i)) : d ? () => setDestinos([null]) : null}
            tirarLabel=${destinos.length > 1 ? 'Tirar este destino' : 'Tirar o destino'}
          />`,
        )}
        ${destinos.length < 4 && !travado
          ? html`<button type="button" class="cp-mais" onClick=${() => setDestinos([...destinos, null])}><span><${Icon} name="plus" size=${14} strokeWidth=${2.2} /></span> Outro destino (backup)</button>`
          : null}
      </div>
      <div class="cp-nome">
        <label class="k-rot" for="dk-nome">Pasta no destino</label>
        <input id="dk-nome" class="input" type="text" maxlength="120" placeholder=${origem ? baseName(origem) : 'Nome da pasta'} value=${nome} onInput=${(e) => setNome(e.currentTarget.value)} />
        <span class="sub mono-path">${destinos.filter(Boolean).length ? `${baseName(destinos.find(Boolean))}/${nomeFinal || '…'}/` : 'Escolha o destino'}</span>
      </div>
    </${Passo}>

    <${Passo} n="3" titulo="Como conferir" frase="Cada arquivo copiado é lido de novo no destino e comparado com a origem." i=${4}>
      <${Opcoes} label="Checksum" valor=${opcoes.algoritmo || 'xxh64'} onEscolher=${(a) => setOpcoes({ ...opcoes, algoritmo: a })} itens=${ALGS} colunas=${2} />
      <${Linhas}>
        <${Linha} titulo="Conferir cada arquivo copiado" sub="Lê o destino de novo e compara o checksum com a origem.">
          <${Switch} checked=${opcoes.conferir} label="Conferir cada arquivo copiado" onChange=${(on) => setOpcoes({ ...opcoes, conferir: on })} />
        </${Linha}>
        <${Linha} titulo="Salvar o relatório de checksums no destino" sub="Para conferir de novo depois, em qualquer ferramenta.">
          <${Switch} checked=${opcoes.relatorio} label="Salvar o relatório" onChange=${(on) => setOpcoes({ ...opcoes, relatorio: on })} />
        </${Linha}>
      </${Linhas}>
    </${Passo}>

    ${v.fase === 'erro' && !v.resultado
      ? html`<${Passo} id="cp-resultado" icone="warning" cor="err" titulo="Não deu para comparar" frase=${v.erro} i=${5} />`
      : null}
    ${canceladoAntes
      ? html`<${Passo} id="cp-resultado" icone="x" cor="warn" titulo="Comparação cancelada" frase="Parou no meio. Nada foi copiado." i=${5} acao=${html`<div class="cp-acoes-topo"><${Button} icon="trash" onClick=${limpar}>Limpar</${Button}><${Button} icon="retry" onClick=${comparar} disabled=${!pronto}>Comparar de novo</${Button}></div>`} />`
      : null}
    ${v.fase === 'pronto' && v.plano ? html`<${Plano} v=${v} opcoes=${opcoes} setOpcoes=${setOpcoes} />` : null}
    ${v.fase === 'copiando' && v.progresso ? html`<${Andamento} v=${v} pontos=${pontos} onCancelar=${cancelar} />` : null}
    ${comResultado ? html`<${Resultado} v=${v} />` : null}
  </${Pagina}>`
}
