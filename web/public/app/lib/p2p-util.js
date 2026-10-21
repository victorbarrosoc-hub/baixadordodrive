// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): as contas sem navegador — nome do aparelho, onde guardar o
// que chega, velocidade, tipo do arquivo. Sem imports: o teste (test/celular-wifi-app.test.js) roda no Node.

/** Sem o armazenamento do app (OPFS), o que chega fica na memória: até este tanto de uma vez. */
export const LIMITE_MEMORIA = 1024 ** 3

/** Nome que o computador mostra para este aparelho ("iPhone", "iPad", "Android"…). */
export function nomeAparelho(ua = '') {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return 'iPad'
  if (/iPhone|iPod/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Celular Android' : 'Tablet Android'
  return 'Celular'
}

/**
 * Onde guardar o que vai chegar, ou por que não dá.
 * @param {{ modo: 'worker' | 'writable' | null, total: number, livre?: number | null }} o
 *   modo: o que o aparelho tem (OPFS pelo worker, OPFS pela página, ou nada); livre: o que a cota ainda deixa.
 * @returns {{ modo: 'worker' | 'writable' | 'memoria' } | { motivo: string }}
 */
export function ondeGuardar({ modo, total, livre = null }) {
  if (livre != null && Number.isFinite(livre) && total > livre) return { motivo: 'Falta espaço no celular para receber esses arquivos.' }
  if (modo) return { modo }
  if (total > LIMITE_MEMORIA) return { motivo: 'Este navegador só consegue receber até 1 GB de uma vez. Mande menos arquivos de cada vez.' }
  return { modo: 'memoria' }
}

/** Nome de arquivo sem caminho nem caracteres que o sistema não aceita. */
export function nomeSeguro(nome, i = 0) {
  const base = String(nome || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200)
  return base || `arquivo-${i + 1}`
}

const TIPOS = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  webp: 'image/webp',
  dng: 'image/x-adobe-dng',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  srt: 'application/x-subrip',
}

/** O tipo que veio, ou o da extensão (a folha de compartilhar do iPhone só oferece "Salvar em Fotos" com o tipo certo). */
export function tipoDe(nome, tipo = '') {
  if (tipo && /^[\w.+-]+\/[\w.+-]+$/.test(tipo)) return tipo
  const ext = String(nome || '').toLowerCase().split('.').pop()
  return TIPOS[ext] || 'application/octet-stream'
}

/** Velocidade pelos últimos segundos (bytes/s). */
export class Medidor {
  constructor(janelaMs = 3000) {
    this.janela = janelaMs
    this.amostras = []
  }
  marcar(bytes, t = Date.now()) {
    this.amostras.push({ t, bytes })
    while (this.amostras.length > 2 && t - this.amostras[0].t > this.janela) this.amostras.shift()
  }
  get velocidade() {
    const a = this.amostras
    if (a.length < 2) return 0
    const dt = a[a.length - 1].t - a[0].t
    return dt > 0 ? ((a[a.length - 1].bytes - a[0].bytes) * 1000) / dt : 0
  }
}

const CAMINHO = { host: 'local', srflx: 'internet', prflx: 'descoberto', relay: 'retransmitido' }

/**
 * Por que não conectou, a partir das estatísticas do WebRTC: os caminhos de cada lado e quantas checagens foram e
 * voltaram. Muitas idas e nenhuma volta = o outro lado não responde (no Mac, quase sempre a Rede Local desligada).
 */
export function resumoConexao(stats, estado) {
  const local = new Set()
  const remoto = new Set()
  let idas = 0
  let voltas = 0
  for (const r of stats?.values?.() || []) {
    if (r.type === 'local-candidate') local.add(CAMINHO[r.candidateType] || r.candidateType)
    else if (r.type === 'remote-candidate') remoto.add(CAMINHO[r.candidateType] || r.candidateType)
    else if (r.type === 'candidate-pair') {
      idas += Number(r.requestsSent) || 0
      voltas += Number(r.responsesReceived) || 0
    }
  }
  return { local: [...local], remoto: [...remoto], idas, voltas, estado: estado || '' }
}

/**
 * O que o outro lado anunciou na SDP (as linhas a=candidate), para saber se veio algum caminho que dá para usar:
 * "2 local 192.168.15.x, 1 local .local, 1 internet". IP local só até o terceiro número (a rede, não o aparelho).
 */
export function candidatosDaSdp(sdp) {
  const conta = new Map()
  for (const linha of String(sdp || '').split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/i.exec(linha)
    if (!m) continue
    const [, transporte, endereco, tipo] = m
    let onde = ''
    if (tipo === 'host') {
      if (/\.local$/i.test(endereco)) onde = '.local'
      else if (endereco.includes(':')) onde = 'IPv6'
      else onde = endereco.split('.').slice(0, 3).join('.') + '.x'
    }
    const k = `${CAMINHO[tipo] || tipo}${onde ? ` ${onde}` : ''}${transporte.toLowerCase() === 'tcp' ? ' tcp' : ''}`
    conta.set(k, (conta.get(k) || 0) + 1)
  }
  return [...conta].map(([k, n]) => `${n} ${k}`)
}

/** Uma linha curta para o print: "Este: local, internet · Outro: local · 24 idas, 0 voltas · failed · SDP do outro: …". */
export function textoConexao(d) {
  if (!d) return ''
  const lista = (a) => (a.length ? a.join(', ') : 'nenhum')
  const sdp = d.sdpOutro ? ` · SDP do outro: ${lista(d.sdpOutro)}` : ''
  return `Este: ${lista(d.local)} · Outro: ${lista(d.remoto)} · ${d.idas} idas, ${d.voltas} voltas${d.estado ? ` · ${d.estado}` : ''}${sdp}`
}

export const DICA_MAC = 'Se o outro for um Mac: Ajustes do Sistema → Privacidade e Segurança → Rede Local → ligue o SOBEDESCE.'

/** Mensagem para a pessoa a partir de um erro do canal ou da rede. */
export function mensagemDe(err) {
  const m = err?.motivo
  if (m === 'rede') return 'Não deu para conectar. Confira se os dois estão no mesmo Wi-Fi.'
  if (m === 'caiu') return 'A conexão caiu. Confira se os dois continuam no mesmo Wi-Fi e tente de novo.'
  if (m === 'parado') return 'O outro aparelho parou de responder.'
  if (m === 'cancelado') return err.message && err.message !== 'Cancelado.' ? err.message : 'Cancelado.'
  return err?.message || 'Algo deu errado. Tente de novo.'
}
