// Calculadora de mídia (docs da aba Cartões, §6): quanto cada câmera grava por hora, quanto cabe em cada cartão,
// quantos cartões levar, o tamanho dos HDs de backup e o tempo de cópia. Só conta, sem nada inventado: a conta sai
// inteira, linha por linha, para a tela mostrar.
//
// Uma cópia idêntica fica no app do computador (public/lib/midia-conta.js); test/midia-conta.test.js confere que as
// duas são iguais.

const num = (n, casas = 1) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: casas, minimumFractionDigits: 0 }).format(n)

/** GB (do fabricante: 1 GB = 1.000.000.000 bytes) por hora de gravação. 100 Mb/s → 45 GB por hora. */
export function gbPorHora(mbps) {
  return (mbps * 3600) / 8 / 1000
}

/** MB/s (megabytes) de um bitrate em Mb/s (megabits). */
export const mbParaMBs = (mbps) => mbps / 8

/** Duração legível: "1 h 11 min", "38 min", "2 h". */
export function duracao(segundos) {
  if (!Number.isFinite(segundos) || segundos <= 0) return '0 min'
  const min = Math.round(segundos / 60)
  if (min < 1) return 'menos de 1 min'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`
}

/** GB legível: "1.080 GB", "1,3 TB" (sempre na conta do fabricante). */
export function tamanho(gb) {
  return gb >= 1000 ? `${num(gb / 1000, 2)} TB` : `${num(gb, gb < 10 ? 1 : 0)} GB`
}

/**
 * O cartão de "128 GB" no computador: o Mac conta como o fabricante (1 GB = 1.000.000.000 bytes) e mostra perto de
 * 128; o Windows conta em 1.073.741.824 bytes e mostra perto de 119. Depois de formatado, um pouco menos nos dois.
 */
export function comoOComputadorMostra(gbFabricante) {
  return { mac: gbFabricante, windows: (gbFabricante * 1e9) / 2 ** 30 }
}

/**
 * @param {object} e
 * @param {{ nome: string, mbps: number|null, horas: number|null }[]} e.cameras horas de gravação previstas de cada câmera
 * @param {number} e.cartaoGB capacidade impressa no cartão (GB do fabricante)
 * @param {number} [e.margem] folga nos cartões (0,2 = 20%)
 * @param {number} [e.copias] cópias de backup (2 = dois HDs)
 * @param {number|null} [e.leitorMBs] velocidade do leitor de cartão (MB/s), se souber
 * @param {number|null} [e.hdMBs] velocidade de escrita do HD mais lento (MB/s), se souber
 */
export function calcular({ cameras, cartaoGB, margem = 0.2, copias = 2, leitorMBs = null, hdMBs = null }) {
  const linhas = []
  let totalGB = 0
  let totalCartoes = 0
  for (const c of cameras) {
    if (!(c.mbps > 0) || !(c.horas > 0)) continue
    const gbh = gbPorHora(c.mbps)
    const gb = gbh * c.horas
    const horasPorCartao = cartaoGB / gbh
    const cartoes = Math.max(1, Math.ceil((gb * (1 + margem)) / cartaoGB - 1e-9))
    totalGB += gb
    totalCartoes += cartoes
    linhas.push({
      nome: c.nome || 'Câmera',
      mbps: c.mbps,
      gbh,
      horas: c.horas,
      gb,
      horasPorCartao,
      cartoes,
      conta: [
        `${num(c.mbps)} Mb/s × 3.600 s ÷ 8 ÷ 1.000 = ${num(gbh)} GB por hora`,
        `${num(c.horas)} h × ${num(gbh)} GB = ${tamanho(gb)}`,
        `Cartão de ${num(cartaoGB)} GB ÷ ${num(gbh)} GB por hora = ${duracao(horasPorCartao * 3600)} por cartão`,
        `${tamanho(gb)} + ${num(margem * 100, 0)}% de margem = ${tamanho(gb * (1 + margem))} ÷ ${num(cartaoGB)} GB = ${num((gb * (1 + margem)) / cartaoGB, 1)} → ${cartoes} ${cartoes === 1 ? 'cartão' : 'cartões'}`,
      ],
    })
  }
  const hdGB = totalGB * copias
  const conta = []
  if (linhas.length) {
    if (linhas.length > 1) conta.push(`Total gravado: ${linhas.map((l) => tamanho(l.gb)).join(' + ')} = ${tamanho(totalGB)}`)
    conta.push(`Backup: ${tamanho(totalGB)} × ${copias} ${copias === 1 ? 'cópia' : 'cópias'} = ${tamanho(hdGB)} (${copias === 1 ? 'um HD' : `um HD de pelo menos ${tamanho(totalGB)} para cada cópia`})`)
  }
  // Tempo: o cartão é lido uma vez e os HDs gravam juntos (vale o mais lento); conferir é ler de volta de cada HD.
  const copiaMBs = leitorMBs > 0 && hdMBs > 0 ? Math.min(leitorMBs, hdMBs) : leitorMBs > 0 ? leitorMBs : hdMBs > 0 ? hdMBs : null
  const tempoCopiaS = copiaMBs ? (totalGB * 1000) / copiaMBs : null
  const tempoConferenciaS = hdMBs > 0 ? (totalGB * 1000) / hdMBs : null
  if (tempoCopiaS != null) {
    const quem = leitorMBs > 0 && hdMBs > 0 ? (leitorMBs <= hdMBs ? ' (o leitor é o limite)' : ' (o HD é o limite)') : ''
    conta.push(`Cópia: ${tamanho(totalGB)} ÷ ${num(copiaMBs, 0)} MB/s = ${duracao(tempoCopiaS)}${quem}`)
  }
  if (tempoConferenciaS != null) conta.push(`Conferência (ler de volta dos HDs): ${tamanho(totalGB)} ÷ ${num(hdMBs, 0)} MB/s = ${duracao(tempoConferenciaS)}`)
  return {
    linhas,
    totalGB,
    totalCartoes,
    hdGB,
    copias,
    margem,
    cartaoGB,
    tempoCopiaS,
    tempoConferenciaS,
    tempoTotalS: tempoCopiaS != null ? tempoCopiaS + (tempoConferenciaS || 0) : null,
    conta,
  }
}
