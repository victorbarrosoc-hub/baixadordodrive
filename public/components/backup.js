// Cartões → Backup Automático (docs/BACKUP-AUTOMATICO.md): o projeto configurado uma vez; depois é só espetar o cartão.
// Na primeira vez, um toque diz de quem ele é ("Aladim" + "FX30"); nas próximas, passa sozinho para
// Diária NN / Cenas / Dono - Câmera / Cartão NN em cada destino, compara, confere e diz se pode formatar.
// Motor em src/backup/ (estado pelo SSE 'backup'). Visual no padrão do kit (docs/UI-KIT.md).
import { html, useEffect, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { bytes, count, plural, tildify, baseName } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { pickFolderPath } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Switch } from './common.js'
import { Barra, BotaoGrande, Destaque, GraficoVelocidade, Item, Linha, Linhas, Pagina, Passo, Resumo, Stats, Vazio } from './kit.js'
import { useLocalRoots } from './local-picker.js'
import { Fonte } from './comparar-partes.js'
import { duracao } from './discos.js'

const FRASE = 'Espete o cartão: o backup passa sozinho, organizado por diária e por dono.'
const post = (url, body = {}) => attempt(api.post(url, body))

const ESTADO = {
  lendo: { texto: 'Lendo o cartão', tom: 'down', icone: 'refresh' },
  pedido: { texto: 'De quem é?', tom: 'warn', icone: 'user' },
  fila: { texto: 'Na fila', tom: 'down', icone: 'clock' },
  copiando: { texto: 'Passando agora', tom: 'up', icone: 'copy' },
  ok: { texto: 'OK, pode formatar', tom: 'ok', icone: 'circle-check' },
  falta: { texto: 'Tem pendência', tom: 'warn', icone: 'warning' },
  erro: { texto: 'Parou', tom: 'err', icone: 'circle-x' },
  cancelado: { texto: 'Parado', tom: 'warn', icone: 'x' },
  ignorado: { texto: 'Ignorado', tom: 'neutro', icone: 'eye-off' },
  disco: { texto: 'Plugado', tom: 'neutro', icone: 'disk' },
  pronto: { texto: 'Pronto para copiar', tom: 'down', icone: 'sdcard' },
  destino: { texto: 'Destino deste projeto', tom: 'neutro', icone: 'disk' },
  ejetado: { texto: 'Ejetado · pode tirar', tom: 'ok', icone: 'check' },
}

const horaDe = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// ───── criar / editar o projeto ─────

function FormProjeto({ inicial, onPronto, onCancelar, topo }) {
  const roots = useLocalRoots()
  const [nome, setNome] = useState(inicial?.nome || '')
  const [destinos, setDestinos] = useState(inicial?.destinos?.length ? inicial.destinos.map((d) => d.caminho) : [null])
  const [ejetar, setEjetar] = useState(!!inicial?.ejetar)
  const [ligar, setLigar] = useState(true)
  const [ocupado, setOcupado] = useState(false)
  const ds = destinos.filter(Boolean)
  const escolher = (atual) => pickFolderPath({ title: 'Onde guardar o backup?', defaultPath: atual || undefined })
  const salvar = async () => {
    setOcupado(true)
    const r = inicial ? await post('/api/backup/projeto', { id: inicial.id, nome, destinos: ds, ejetar }) : await post('/api/backup/projetos', { nome, destinos: ds, ejetar, ligar })
    setOcupado(false)
    if (r) onPronto?.()
  }
  const exemplo = [ds[0] ? baseName(ds[0]) : 'HD', nome.trim() || 'Projeto', 'Diária 01', 'Cenas', 'Aladim - FX30', 'Cartão 01']
  const dica = !nome.trim() ? 'Falta o nome do projeto' : !ds.length ? 'Falta escolher onde guardar' : ds.length === 1 ? 'Com dois destinos você já sai com o backup' : `${ds.length} destinos ao mesmo tempo`
  const lado = html`<${Resumo} titulo="Como fica no disco">
      <div class="k-caixa bk-arvore" aria-label="Pastas">
        ${exemplo.map(
          (p, i) => html`<div class="bk-arvore-linha" style=${`--n:${i}`}>
            <${Icon} name=${i === 0 ? 'disk' : i === exemplo.length - 1 ? 'sdcard' : 'folder'} size=${14} />
            <span class=${cx(i >= 4 && 'is-dono')}>${p}</span>
          </div>`,
        )}
      </div>
      <p class="cp-resumo-txt">O dono do cartão é perguntado só na primeira vez que ele é espetado.</p>
    </${Resumo}>
    <${BotaoGrande} icone="check" onClick=${salvar} disabled=${ocupado || !nome.trim() || !ds.length} dica=${dica}>${inicial ? 'Salvar' : 'Criar o projeto'}</${BotaoGrande}>
    ${onCancelar ? html`<${Button} icon="x" onClick=${onCancelar} class="cp-lado-btn">Cancelar</${Button}>` : null}`

  return html`<${Pagina} titulo="Cartões" frase=${FRASE} class="page-backup" lado=${lado}>
    ${topo}
    <${Passo} n="1" titulo=${inicial ? 'O projeto' : 'Novo projeto'} frase="O nome vira a pasta principal em cada destino." i=${2}>
      <input class="input bk-nome" type="text" maxlength="120" placeholder="ex.: SERHS · Evento de verão" value=${nome} onInput=${(e) => setNome(e.currentTarget.value)} aria-label="Nome do projeto" />
    </${Passo}>
    <${Passo} n="2" titulo="Para onde" sub=${ds.length > 1 ? `${ds.length} destinos` : 'destino'} frase="O HD principal e os backups. O cartão é lido uma vez e gravado em todos." i=${3}>
      <div class="cp-destinos">
        ${destinos.map(
          (d, i) => html`<${Fonte}
            key=${i}
            icone="disk"
            tom="up"
            rotulo=${destinos.length > 1 ? (i === 0 ? 'Principal' : `Backup ${i}`) : null}
            valor=${d ? baseName(d) || d : null}
            caminho=${d ? tildify(d, roots?.home) : ''}
            vazio=${i === 0 ? 'Escolher o HD principal' : `Escolher o backup ${i}`}
            dica="O HD ou a pasta onde o projeto fica"
            onTrocar=${async () => {
              const p = await escolher(d)
              if (p) setDestinos(destinos.map((x, k) => (k === i ? p : x)))
            }}
            onSoltarPasta=${(p) => setDestinos(destinos.map((x, k) => (k === i ? p : x)))}
            onTirar=${destinos.length > 1 ? () => setDestinos(destinos.filter((_, k) => k !== i)) : d ? () => setDestinos([null]) : null}
            tirarLabel="Tirar este destino"
          />`,
        )}
        ${destinos.length < 4
          ? html`<button type="button" class="cp-mais" onClick=${() => setDestinos([...destinos, null])}><span><${Icon} name="plus" size=${14} strokeWidth=${2.2} /></span> Outro destino (backup)</button>`
          : null}
      </div>
    </${Passo}>
    <${Passo} n="3" titulo="No fim" frase="Cada arquivo copiado é lido de novo no destino e conferido." i=${4}>
      <${Linhas}>
        ${inicial
          ? null
          : html`<${Linha} titulo="Começar sozinho ao espetar" sub="O cartão conhecido passa direto; o novo pergunta de quem é.">
              <${Switch} checked=${ligar} label="Começar sozinho ao espetar" onChange=${setLigar} />
            </${Linha}>`}
        <${Linha} titulo="Ejetar o cartão ao terminar" sub="Só quando estiver tudo certo em todos os destinos.">
          <${Switch} checked=${ejetar} label="Ejetar o cartão ao terminar" onChange=${setEjetar} />
        </${Linha}>
      </${Linhas}>
    </${Passo}>
  </${Pagina}>`
}

const pastaPadrao = (nome, camera) => [nome.trim() || 'Nome', camera.trim()].filter(Boolean).join(' - ')

// ───── "de quem é este cartão?" ─────

function Pedido({ p, donos, i }) {
  const [donoId, setDonoId] = useState(p.donoSugerido || null)
  const [novo, setNovo] = useState(!donos.length)
  const [nome, setNome] = useState('')
  const [camera, setCamera] = useState(p.camera?.curto && p.camera.curto !== p.camera.marca ? p.camera.curto : p.camera?.curto || '')
  const [pasta, setPasta] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const responder = async (extra) => {
    setOcupado(true)
    await post('/api/backup/responder', { caminho: p.caminho, ...extra })
    setOcupado(false)
  }
  const pronto = novo ? !!nome.trim() : !!donoId
  const cam = p.camera?.modelo ? `${p.camera.curto} (${p.camera.modelo})` : p.camera?.curto
  return html`<section class="bk-pedido k-entra" style=${`--i:${i}`} role="alertdialog" aria-label=${`Cartão novo: ${p.nome}`}>
    <div class="bk-pedido-topo">
      <span class="bk-pedido-ic" aria-hidden="true"><${Icon} name="sdcard" size=${22} strokeWidth=${1.8} /></span>
      <div class="bk-pedido-txt">
        <span class="k-rot">Cartão novo · um toque só</span>
        <h2>De quem é o cartão “${p.nome}”?</h2>
        <p>${[p.capacidade ? bytes(p.capacidade) : null, cam ? `câmera ${cam}` : null].filter(Boolean).join(' · ') || 'Nas próximas vezes ele passa sozinho.'}</p>
      </div>
    </div>
    ${donos.length
      ? html`<div class="bk-donos-escolha" role="radiogroup" aria-label="Dono do cartão">
          ${donos.map(
            (d) => html`<button type="button" role="radio" aria-checked=${!novo && donoId === d.id ? 'true' : 'false'} class=${cx('bk-dono-btn', !novo && donoId === d.id && 'is-on')} onClick=${() => (setNovo(false), setDonoId(d.id))}>
              <${Icon} name="user" size=${14} />${d.rotulo}${p.donoSugerido === d.id ? html`<em>mesma câmera</em>` : null}
            </button>`,
          )}
          <button type="button" role="radio" aria-checked=${novo ? 'true' : 'false'} class=${cx('bk-dono-btn is-novo', novo && 'is-on')} onClick=${() => setNovo(true)}><${Icon} name="plus" size=${14} />Outra pessoa</button>
        </div>`
      : null}
    ${novo
      ? html`<div class="bk-novo-dono">
          <label><span class="k-rot">Nome</span><input class="input" type="text" maxlength="60" placeholder="ex.: Aladim" value=${nome} onInput=${(e) => setNome(e.currentTarget.value)} /></label>
          <label><span class="k-rot">Câmera</span><input class="input" type="text" maxlength="40" placeholder="ex.: FX30" value=${camera} onInput=${(e) => setCamera(e.currentTarget.value)} /></label>
          <label class="bk-novo-pasta-campo"><span class="k-rot">Nome da pasta <em>opcional</em></span><input class="input mono-path" type="text" maxlength="80" placeholder=${pastaPadrao(nome, camera)} value=${pasta} onInput=${(e) => setPasta(e.currentTarget.value)} aria-label="Nome da pasta do dono" /></label>
          <span class="bk-novo-pasta mono-path">Cenas / ${pasta.trim() || pastaPadrao(nome, camera)} / Cartão 01</span>
        </div>`
      : null}
    <div class="bk-pedido-acoes">
      <${Button} variant="ghost" icon="eye-off" onClick=${() => responder({ ignorar: true })} disabled=${ocupado}>Ignorar este disco</${Button}>
      <button type="button" class="k-botao bk-comecar" disabled=${ocupado || !pronto} onClick=${() => responder(novo ? { nome, camera, pasta } : { donoId })}>
        <${Icon} name="copy" size=${18} strokeWidth=${2} />Começar o backup
      </button>
    </div>
  </section>`
}

// ───── os donos da diária (com a pasta de cada um) ─────

function Dono({ d, k, bloqueado }) {
  const [editando, setEditando] = useState(false)
  const [nome, setNome] = useState(d.nome || '')
  const [camera, setCamera] = useState(d.camera || '')
  const [pasta, setPasta] = useState(d.pastaPropria ? d.pasta : '')
  const [ocupado, setOcupado] = useState(false)
  const abrir = () => {
    setNome(d.nome || '')
    setCamera(d.camera || '')
    setPasta(d.pastaPropria ? d.pasta : '')
    setEditando(true)
  }
  const salvar = async () => {
    setOcupado(true)
    const r = await post('/api/backup/dono', { id: d.id, nome, camera, pasta })
    setOcupado(false)
    if (r) setEditando(false)
  }
  if (editando) {
    return html`<div class="bk-dono is-editando">
      <div class="bk-novo-dono">
        <label><span class="k-rot">Nome</span><input class="input" type="text" maxlength="60" value=${nome} onInput=${(e) => setNome(e.currentTarget.value)} /></label>
        <label><span class="k-rot">Câmera</span><input class="input" type="text" maxlength="40" value=${camera} onInput=${(e) => setCamera(e.currentTarget.value)} /></label>
        <label class="bk-novo-pasta-campo"><span class="k-rot">Nome da pasta <em>opcional</em></span><input class="input mono-path" type="text" maxlength="80" placeholder=${pastaPadrao(nome, camera)} value=${pasta} onInput=${(e) => setPasta(e.currentTarget.value)} aria-label="Nome da pasta do dono" /></label>
        <span class="bk-novo-pasta">Os cartões que já passaram ficam onde estão. Os próximos vão para “${pasta.trim() || pastaPadrao(nome, camera)}”.</span>
      </div>
      <div class="bk-dono-acoes">
        <${Button} size="sm" variant="ghost" onClick=${() => setEditando(false)} disabled=${ocupado}>Cancelar</${Button}>
        <${Button} size="sm" icon="check" onClick=${salvar} disabled=${ocupado || !nome.trim()}>Salvar</${Button}>
      </div>
    </div>`
  }
  return html`<div class="bk-dono k-entra" style=${`--i:${k}`}>
    <span class="bk-dono-ic"><${Icon} name="user" size=${16} /></span>
    <b>${d.rotulo}</b>
    <span>${d.cartoes ? `${plural(d.cartoes, 'cartão', 'cartões')} · ${bytes(d.bytes)}` : 'Nenhum cartão nesta diária'}</span>
    <span class="bk-dono-pasta mono-path" title="Pasta dentro de Cenas"><${Icon} name="folder" size=${12} />${d.pasta}</span>
    <button type="button" class="bk-dono-editar" onClick=${abrir} disabled=${bloqueado} aria-label=${`Editar ${d.rotulo}`} title="Editar nome, câmera e pasta"><${Icon} name="pencil" size=${13} /></button>
  </div>`
}

// ───── a descarga de agora ─────

function Agora({ job, pontos }) {
  const g = job.progresso
  if (job.fase === 'esperando-destino') {
    return html`<${Passo} icone="disk" cor="warn" titulo=${`Esperando ${job.faltando.join(' e ')}`} frase=${`O cartão de ${job.dono} está pronto. Conecte o destino: começa sozinho.`} i=${3}>
      <${Barra} p=${null} label="Esperando o destino" />
    </${Passo}>`
  }
  const frac = g ? (g.copiados + g.conferidos) / (g.totalBytes + g.totalConferir || 1) : null
  return html`<${Passo}
    icone="copy"
    cor="up"
    titulo=${job.dono}
    sub=${job.nome}
    frase=${job.pasta}
    i=${3}
    acao=${html`<${Button} size="sm" icon="x" onClick=${() => post('/api/backup/cancelar')}>Parar</${Button}>`}
  >
    <${Barra} p=${job.fase === 'comparando' ? null : frac} vivo label="Andamento da descarga" />
    ${g
      ? html`<${Stats}
          colunas=${4}
          itens=${[
            { icone: 'gauge', valor: g.velocidade ? `${bytes(g.velocidade)}/s` : '—', rotulo: 'agora', tom: 'up' },
            { icone: 'doc', valor: `${count(g.arquivos)}/${count(g.totalArquivos)}`, rotulo: 'arquivos', tom: 'down' },
            { icone: 'clock', valor: g.restante != null ? duracao(g.restante) : '—', rotulo: 'falta', tom: 'ok' },
            { icone: 'shield', valor: g.etapa === 'conferindo' ? 'conferindo' : `${bytes(g.copiados)}`, rotulo: g.etapa === 'conferindo' ? 'lendo de volta' : `de ${bytes(g.totalBytes)}`, tom: 'neutro' },
          ]}
        />`
      : html`<p class="bk-fase">${job.fase === 'comparando' ? (job.tentativa ? 'Comparando de novo: confere se ficou tudo' : 'Comparando o cartão com os destinos') : 'Preparando'}</p>`}
    ${pontos.length > 1 ? html`<div class="cp-grafico"><${GraficoVelocidade} pontos=${pontos.map((x) => ({ up: x }))} altura=${90} label="Velocidade da descarga" /></div>` : null}
  </${Passo}>`
}

function Ultimo({ u }) {
  if (!u || u.resultado === 'ok') return null
  const lista = [...(u.listaFaltam || []).map((r) => ({ r, tipo: 'falta' })), ...(u.listaAlertas || []).map((r) => ({ r, tipo: 'alerta' }))]
  return html`<${Passo}
    icone="warning"
    cor=${u.resultado === 'cancelado' ? 'warn' : 'err'}
    titulo=${u.resultado === 'cancelado' ? `Descarga parada: ${u.dono}` : `Ainda não formate: ${u.dono}`}
    frase=${u.erro || [u.faltam ? `${plural(u.faltam, 'arquivo não está', 'arquivos não estão')} em todos os destinos` : null, u.alertas ? `${plural(u.alertas, 'arquivo tem', 'arquivos têm')} o mesmo nome e outro tamanho no destino (nada foi gravado por cima)` : null].filter(Boolean).join('. ')}
    i=${4}
  >
    ${lista.length
      ? html`<ul class="bk-lista">${lista.map((x) => html`<li class=${cx(x.tipo === 'alerta' && 'is-alerta')}><${Icon} name=${x.tipo === 'alerta' ? 'warning' : 'minus'} size=${12} /><span class="mono-path">${x.r}</span></li>`)}</ul>`
      : null}
  </${Passo}>`
}

function Volume({ v }) {
  const e = ESTADO[v.estado] || ESTADO.lendo
  const acoes = []
  if (v.estado === 'disco' || v.estado === 'ignorado') acoes.push(html`<${Button} size="sm" icon="sdcard" onClick=${() => post('/api/backup/usar', { caminho: v.caminho })}>Usar como cartão</${Button}>`)
  if (v.estado === 'pronto') acoes.push(html`<${Button} size="sm" icon="copy" onClick=${() => post('/api/backup/usar', { caminho: v.caminho })}>Copiar agora</${Button}>`)
  if (['ok', 'falta', 'erro', 'cancelado'].includes(v.estado) && v.dono && v.estado !== 'ok') acoes.push(html`<${Button} size="sm" icon="retry" onClick=${() => post('/api/backup/repetir', { caminho: v.caminho })}>Copiar de novo</${Button}>`)
  if (!['copiando', 'ejetado', 'lendo', 'destino'].includes(v.estado)) acoes.push(html`<${Button} size="sm" icon="arrow-up" onClick=${() => post('/api/backup/ejetar', { caminho: v.caminho })}>Ejetar</${Button}>`)
  const tam = v.capacidade ? bytes(v.capacidade) : null
  return html`<${Item}
    icone=${v.estado === 'destino' || v.estado === 'disco' ? 'disk' : 'sdcard'}
    tom=${e.tom}
    titulo=${v.nome}
    sub=${v.erro || [v.dono || e.texto, tam].filter(Boolean).join(' · ')}
    fim=${html`<span class=${cx('bk-estado', `is-${e.tom}`)}><${Icon} name=${e.icone} size=${13} />${e.texto}</span>${acoes}`}
  />`
}

// ───── o painel do projeto ─────

/**
 * Um destino: quanto ainda cabe na mídia física (barra do que já ocupou) e, com a média dos cartões da diária,
 * quantos cartões ainda cabem. Pouco espaço (menos de 10% ou de 2 cartões) fica em laranja.
 */
function EspacoDestino({ d, i, media }) {
  const papel = i === 0 ? 'Principal' : `Backup ${i}`
  if (d.conectado === false) {
    return html`<div class="bk-destino is-fora">
      <span class="bk-destino-ic"><${Icon} name="disk" size=${15} /></span>
      <span class="bk-destino-txt"><b>${d.nome}</b><span>${papel} · desconectado</span></span>
    </div>`
  }
  const temTotal = d.total != null && d.livre != null && d.total > 0
  const usado = temTotal ? 1 - d.livre / d.total : null
  const cabem = media && d.livre != null ? Math.floor(d.livre / media) : null
  const pouco = d.livre != null && ((temTotal && d.livre / d.total < 0.1) || (cabem != null && cabem < 2))
  return html`<div class=${cx('bk-destino', 'is-espaco', pouco && 'is-pouco')}>
    <span class="bk-destino-ic"><${Icon} name="disk" size=${15} /></span>
    <span class="bk-destino-txt">
      <span class="bk-destino-linha"><b>${d.nome}</b><span class="bk-destino-livre">${d.livre != null ? `${bytes(d.livre)} livres` : '…'}</span></span>
      ${temTotal ? html`<${Barra} p=${usado} tom=${pouco ? 'erro' : undefined} label=${`Espaço usado em ${d.nome}`} />` : null}
      <span>${papel}${temTotal ? ` · de ${bytes(d.total)}` : ''}${cabem != null ? ` · cabem ~${count(cabem)} ${cabem === 1 ? 'cartão' : 'cartões'} como os de hoje` : ''}</span>
    </span>
  </div>`
}

function Painel({ v, topo, onNovo, onEditar }) {
  const p = v.projeto
  const [pontos, setPontos] = useState([])
  const g = v.job?.progresso
  useEffect(() => {
    if (!g) return
    setPontos((x) => [...x.slice(-59), g.velocidade || 0])
  }, [g?.copiados, g?.conferidos])
  useEffect(() => {
    if (!v.job) setPontos([])
  }, [v.job?.caminho])

  const desligado = !v.ligado
  let destaque
  if (desligado) destaque = html`<${Destaque} tom="grad" titulo="Desligado" linha="Os cartões esperam o seu toque: “Usar como cartão”" />`
  else if (v.job?.fase === 'esperando-destino') destaque = html`<${Destaque} tom="erro" titulo="Esperando o destino" linha=${`Conecte ${v.job.faltando.join(' e ')}`} />`
  else if (v.job) {
    const frac = g ? (g.copiados + g.conferidos) / (g.totalBytes + g.totalConferir || 1) : null
    destaque = html`<${Destaque} titulo=${`Passando · ${v.job.dono}`} numero=${frac != null ? Math.floor(frac * 100) : '…'} unidade=${frac != null ? '%' : ''} progresso=${frac} linha=${g ? `${bytes(g.copiados)} de ${bytes(g.totalBytes)}` : 'Comparando'} vivo />`
  } else if (v.pedidos.length) destaque = html`<${Destaque} tom="erro" titulo="Cartão novo" numero=${v.pedidos.length} unidade=${v.pedidos.length === 1 ? 'esperando o dono' : 'esperando o dono'} linha="Um toque e ele passa" />`
  else if (v.ultimo?.resultado === 'ok') destaque = html`<${Destaque} tom="ok" titulo="Cartão OK, pode formatar" numero=${count(v.ultimo.copiados)} unidade=${v.ultimo.copiados === 1 ? 'arquivo novo' : 'arquivos novos'} linha=${`${v.ultimo.dono} · ${bytes(v.ultimo.bytes)} em ${duracao(v.ultimo.segundos)}`} />`
  else destaque = html`<${Destaque} tom="grad" titulo="Ligado" linha="Espete um cartão" vivo />`

  const lado = html`<${Resumo} titulo=${desligado ? 'Backup automático' : 'Agora'}>
      ${destaque}
      <div class="k-caixa bk-destinos">
        ${p.destinos.map((d, i) => html`<${EspacoDestino} d=${d} i=${i} media=${p.mediaCartao} />`)}
      </div>
    </${Resumo}>
    <${Resumo} titulo="Já passou">
      <div class="k-caixa bk-passou">
        <div class="bk-passou-linha">
          <span class="bk-passou-ic is-down"><${Icon} name="sdcard" size=${15} /></span>
          <b>${bytes(p.total.bytes)}</b>
          <span>no projeto · ${plural(p.total.descargas, 'cartão', 'cartões')} · ${plural(p.total.arquivos, 'arquivo', 'arquivos')}</span>
        </div>
        <div class="bk-passou-linha">
          <span class="bk-passou-ic is-up"><${Icon} name="clock" size=${15} /></span>
          <b>${bytes(p.totalDiaria.bytes)}</b>
          <span>na ${p.diaria.nome} · ${plural(p.totalDiaria.descargas, 'cartão', 'cartões')}</span>
        </div>
      </div>
    </${Resumo}>
    ${desligado
      ? html`<${BotaoGrande} icone="sdcard" onClick=${() => post('/api/backup/ligar', { ligado: true })} dica="Cada cartão espetado passa sozinho">Ligar o backup automático</${BotaoGrande}>`
      : html`<div class="bk-ligado"><${Linhas}><${Linha} titulo="Começar sozinho" sub="Ligado: cada cartão espetado passa sozinho."><${Switch} checked=${true} label="Backup automático" onChange=${() => post('/api/backup/ligar', { ligado: false })} /></${Linha}></${Linhas}></div>`}`

  const acoes = html`${v.projetos.length > 1
      ? html`<span class="select bk-projetos"><select value=${v.atual} onChange=${(e) => post('/api/backup/abrir', { id: e.currentTarget.value })} aria-label="Projeto">${v.projetos.map((x) => html`<option value=${x.id}>${x.nome}</option>`)}</select><${Icon} name="chevron-down" size=${12} /></span>`
      : null}
    <${Button} icon="pencil" onClick=${onEditar}>Editar</${Button}>
    <${Button} icon="plus" onClick=${onNovo}>Novo projeto</${Button}>`

  const espetados = v.volumes.filter((x) => x.estado !== 'pedido' && x.estado !== 'copiando')

  return html`<${Pagina} titulo="Cartões" frase=${FRASE} class="page-backup bk-painel" lado=${lado} acoes=${acoes}>
    ${topo}
    ${v.pedidos.map((x, k) => html`<${Pedido} key=${x.caminho} p=${x} donos=${p.donos.map((d) => ({ id: d.id, rotulo: d.rotulo }))} i=${k + 2} />`)}
    ${v.job ? html`<${Agora} job=${v.job} pontos=${pontos} />` : null}
    ${!v.job ? html`<${Ultimo} u=${v.ultimo} />` : null}

    <${Passo}
      icone="clock"
      cor="down"
      titulo=${p.diaria.nome}
      sub=${p.nome}
      frase=${`${p.pasta.split(/[\\/]/).join(' / ')} / …`}
      i=${2}
      acao=${html`<div class="cp-acoes-topo">
        ${p.diarias.length > 1
          ? html`<span class="select bk-diarias"><select value=${p.diaria.n} onChange=${(e) => post('/api/backup/diaria', { n: Number(e.currentTarget.value) })} aria-label="Diária">${p.diarias.map((d) => html`<option value=${d.n}>${d.nome}</option>`)}</select><${Icon} name="chevron-down" size=${12} /></span>`
          : null}
        <${Button} size="sm" icon="plus" onClick=${() => post('/api/backup/diaria')} disabled=${!!v.job}>Nova diária</${Button}>
      </div>`}
    >
      ${p.sugerirNovaDiaria
        ? html`<div class="bk-aviso"><${Icon} name="info" size=${15} /><span>A data mudou desde a última descarga desta diária. Começar a próxima?</span><${Button} size="sm" onClick=${() => post('/api/backup/diaria')} disabled=${!!v.job}>Começar Diária ${String(Math.max(...p.diarias.map((d) => d.n)) + 1).padStart(2, '0')}</${Button}></div>`
        : null}
      ${p.donos.length
        ? html`<div class="bk-donos">${p.donos.map((d, k) => html`<${Dono} key=${d.id} d=${d} k=${k} bloqueado=${v.job?.dono === d.rotulo} />`)}</div>`
        : html`<p class="bk-vazio-txt">Nenhum cartão nesta diária ainda.</p>`}
    </${Passo}>

    ${v.fila.length
      ? html`<${Passo} icone="clock" cor="down" titulo="Na fila" sub=${plural(v.fila.length, 'cartão', 'cartões')} frase="Um cartão por vez: o próximo começa sozinho." i=${5}>
          <div class="k-itens">${v.fila.map((x) => html`<${Item} icone="sdcard" tom="down" titulo=${x.nome} sub=${x.dono} />`)}</div>
        </${Passo}>`
      : null}

    <${Passo}
      icone="disk"
      cor="ok"
      titulo="Discos plugados"
      sub=${espetados.length ? plural(espetados.length, 'disco', 'discos') : null}
      frase="Cartão que não apareceu sozinho? Toque em “Usar como cartão”."
      i=${6}
    >
      ${espetados.length
        ? html`<div class="k-itens">${espetados.map((x) => html`<${Volume} key=${x.caminho} v=${x} />`)}</div>`
        : v.volumes.length
          ? html`<p class="bk-vazio-txt">Os outros discos estão logo acima, esperando ou passando.</p>`
          : html`<p class="bk-vazio-txt">Nenhum cartão ou disco externo plugado agora. Espetou e não apareceu em alguns segundos? Veja se ele aparece no Finder (Mac) ou no Explorador (Windows).</p>`}
    </${Passo}>

    <${Passo}
      icone="list"
      cor="up"
      titulo="Histórico"
      sub=${p.historico.length ? plural(p.historico.length, 'descarga', 'descargas') : null}
      i=${7}
      acao=${p.ignorados ? html`<${Button} size="sm" icon="eye" onClick=${() => post('/api/backup/ignorados/limpar')}>Perguntar de novo pelos ignorados (${p.ignorados})</${Button}>` : null}
    >
      ${p.historico.length
        ? html`<div class="k-itens bk-historico">
            ${p.historico.map(
              (h) => html`<${Item}
                icone=${h.resultado === 'ok' ? 'circle-check' : h.resultado === 'cancelado' ? 'x' : 'warning'}
                tom=${h.resultado === 'ok' ? 'ok' : h.resultado === 'cancelado' ? 'warn' : 'erro'}
                titulo=${`${h.dono} · ${h.cartao}`}
                sub=${h.pasta}
                fim=${html`<span class="bk-hist-fim"><b>${h.copiados ? `${count(h.copiados)} novos · ${bytes(h.bytes)}` : 'nada novo'}</b><span>${horaDe(h.quando)} · ${duracao(h.segundos)}</span></span>`}
              />`,
            )}
          </div>`
        : html`<${Vazio} icone="sdcard" titulo=${v.ligado ? 'Espete o primeiro cartão' : 'Ligue o backup automático'}>
            ${v.ligado ? 'Na primeira vez, um toque diz de quem ele é. Depois, passa sozinho.' : 'Depois é só espetar os cartões. O app compara, copia o que falta e confere.'}
          </${Vazio}>`}
    </${Passo}>
  </${Pagina}>`
}

export function BackupPanel({ topo }) {
  const v = useStore((s) => s.backup)
  const [modo, setModo] = useState(null) // null | 'novo' | 'editar'
  if (!v) {
    return html`<${Pagina} titulo="Cartões" frase=${FRASE} class="page-backup">${topo}<${Passo} icone="refresh" cor="down" titulo="Carregando" i=${2}><${Barra} p=${null} /></${Passo}></${Pagina}>`
  }
  if (!v.projeto || modo === 'novo') return html`<${FormProjeto} topo=${topo} onPronto=${() => setModo(null)} onCancelar=${v.projeto ? () => setModo(null) : null} />`
  if (modo === 'editar') return html`<${FormProjeto} topo=${topo} inicial=${v.projeto} onPronto=${() => setModo(null)} onCancelar=${() => setModo(null)} />`
  return html`<${Painel} v=${v} topo=${topo} onNovo=${() => setModo('novo')} onEditar=${() => setModo('editar')} />`
}
