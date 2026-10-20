// "Entre computadores" (docs/LAN.md): tudo que passa pela rede local vai cifrado com a chave de recepção do computador
// que recebe (32 bytes, só os computadores da mesma conta SOBEDESCE recebem ela, pelo site, por HTTPS).
//
//  - Pedidos de controle (oferta, fim, ping): JSON selado com AES-256-GCM. A resposta também. O cabeçalho
//    `x-sd-meta` (selado) leva a hora do pedido: fora de ±10 min, recusa. Abrir o selo prova que quem pediu tem a chave.
//  - Dados (PUT de um arquivo): cada pedido sorteia uma "sessão" e deriva uma chave só dela (HKDF). O corpo vai em
//    blocos de até 4 MB: [tamanho u32][cifra][tag 16]. O nonce é o número do bloco dentro do pedido; o AAD leva o
//    arquivo e a posição, então um bloco não serve em outro lugar. Nomes de arquivo e conteúdo nunca vão abertos.
import crypto from 'node:crypto'

export const VERSAO = 1
export const BLOCO = 4 * 1024 * 1024
export const TAG = 16
export const DESVIO_MS = 10 * 60_000

export const novaChave = () => crypto.randomBytes(32).toString('base64url')

function bytesDaChave(chave) {
  const b = Buffer.from(String(chave || ''), 'base64url')
  if (b.length !== 32) throw new Error('Chave de recepção inválida.')
  return b
}

const derivar = (chave, uso, sal = '') => Buffer.from(crypto.hkdfSync('sha256', bytesDaChave(chave), Buffer.from(sal), Buffer.from(`sobedesce-lan-v${VERSAO}:${uso}`), 32))

/** Sela um objeto (JSON) para o caminho `aad` (ex.: "POST /lan/v1/ofertas"). */
export function selar(chave, obj, aad) {
  const k = derivar(chave, 'controle')
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', k, iv)
  c.setAAD(Buffer.from(aad))
  const cifra = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, cifra, c.getAuthTag()])
}

/** Abre um selo; lança se a chave não for a certa ou se mexeram no conteúdo. */
export function abrir(chave, buf, aad) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'base64url')
  if (b.length < 12 + TAG) throw new Error('Selo curto demais.')
  const k = derivar(chave, 'controle')
  const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(b.subarray(b.length - TAG))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - TAG)), d.final()]).toString('utf8'))
}

/** Cabeçalho x-sd-meta: hora + o que mais o pedido precisar dizer, selado. */
export const meta = (chave, metodo, caminho, extra = {}) => selar(chave, { ts: Date.now(), ...extra }, `meta ${metodo} ${caminho}`).toString('base64url')

/** Confere o cabeçalho x-sd-meta; devolve o conteúdo ou null (chave errada, adulterado, hora fora). */
export function lerMeta(chave, valor, metodo, caminho, agora = Date.now()) {
  try {
    const m = abrir(chave, String(valor || ''), `meta ${metodo} ${caminho}`)
    if (!Number.isFinite(m.ts) || Math.abs(agora - m.ts) > DESVIO_MS) return null
    return m
  } catch {
    return null
  }
}

/** Cifra de blocos de um PUT: `sessao` (16 bytes base64url, sorteada por quem manda), `arquivo` e `offset` inicial. */
export function cifradorDeDados(chave, { oferta, sessao, arquivo, offset }) {
  const k = derivar(chave, 'dados', `${oferta}:${sessao}`)
  let n = 0
  let pos = offset
  return (parte) => {
    const iv = Buffer.alloc(12)
    iv.writeBigUInt64BE(BigInt(n++), 4)
    const c = crypto.createCipheriv('aes-256-gcm', k, iv)
    c.setAAD(Buffer.from(`${arquivo}:${pos}`))
    pos += parte.length
    const cifra = Buffer.concat([c.update(parte), c.final()])
    const cab = Buffer.alloc(4)
    cab.writeUInt32BE(cifra.length)
    return Buffer.concat([cab, cifra, c.getAuthTag()])
  }
}

/**
 * Lado de quem recebe: vai juntando o que chega da rede e devolve os blocos abertos, em ordem. Bloco adulterado,
 * fora de ordem ou com a chave errada lança.
 */
export function decifradorDeDados(chave, { oferta, sessao, arquivo, offset }) {
  const k = derivar(chave, 'dados', `${oferta}:${sessao}`)
  let n = 0
  let pos = offset
  // O que chegou e ainda não fechou um bloco: lista de pedaços (juntar a cada pedaço de 64 KB recopiaria o bloco
  // inteiro de novo e de novo).
  let partes = []
  let tamanho = 0
  const juntar = () => {
    if (partes.length > 1) partes = [Buffer.concat(partes, tamanho)]
    return partes[0] || Buffer.alloc(0)
  }
  const cabecalho = () => {
    if (partes[0]?.length >= 4) return partes[0].readUInt32BE(0)
    return juntar().readUInt32BE(0)
  }
  return {
    /** Recebe um pedaço da rede; devolve os blocos completos já abertos (Buffer[]). */
    empurrar(pedaco) {
      partes.push(pedaco)
      tamanho += pedaco.length
      const saida = []
      for (;;) {
        if (tamanho < 4) break
        const tam = cabecalho()
        if (tam > BLOCO) throw new Error('Bloco grande demais.')
        if (tamanho < 4 + tam + TAG) break
        const tudo = juntar()
        const iv = Buffer.alloc(12)
        iv.writeBigUInt64BE(BigInt(n++), 4)
        const d = crypto.createDecipheriv('aes-256-gcm', k, iv)
        d.setAAD(Buffer.from(`${arquivo}:${pos}`))
        d.setAuthTag(tudo.subarray(4 + tam, 4 + tam + TAG))
        const claro = Buffer.concat([d.update(tudo.subarray(4, 4 + tam)), d.final()])
        pos += claro.length
        saida.push(claro)
        const resto = tudo.subarray(4 + tam + TAG)
        partes = resto.length ? [resto] : []
        tamanho = resto.length
      }
      return saida
    },
    /** No fim do pedido: sobrou meio bloco? (conexão caiu no meio de um bloco: descarta, a retomada manda de novo) */
    get sobra() {
      return tamanho
    },
  }
}
