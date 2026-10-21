// Backup Automático: de qual câmera é o cartão. A Sony grava um XML ao lado de cada clipe com o modelo e o número de
// série do corpo (<Device manufacturer="Sony" modelName="ILME-FX30" serialNo="5012345"/>): com o serial, um cartão
// formatado (id novo) ainda é reconhecido como do mesmo dono. Das outras marcas, só o tipo pela estrutura de pastas,
// para sugerir o nome da câmera no primeiro toque.
import fsp from 'node:fs/promises'
import path from 'node:path'

// Onde a Sony guarda os XML dos clipes (Alpha/FX/ZV: M4ROOT; XDCAM, FX6, FX9: XDROOT).
const PASTAS_SONY = [
  ['PRIVATE', 'M4ROOT', 'CLIP'],
  ['XDROOT', 'Clip'],
  ['XDROOT', 'CLIP'],
]
const XML_MAX = 64 * 1024

/** O <Device …/> de um XML de clipe da Sony. */
export function lerXmlSony(xml) {
  const tag = /<Device\b([^>]*)\/?>/i.exec(String(xml || ''))?.[1]
  if (!tag) return null
  const attr = (k) => new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1]?.trim() || null
  const modelo = attr('modelName')
  const serial = attr('serialNo')
  if (!modelo && !serial) return null
  return { marca: attr('manufacturer') || 'Sony', modelo, serial }
}

/** "ILME-FX30" → "FX30", "ILCE-7SM3" → "A7S III", "ILCE-7M4" → "A7 IV", "ZV-E1" → "ZV-E1". */
export function nomeCurto(modelo) {
  const m = String(modelo || '').trim()
  if (!m) return null
  const sony = /^IL[CM]E-(.+)$/i.exec(m)?.[1]
  if (!sony) return m
  if (/^FX/i.test(sony)) return sony.toUpperCase()
  const romano = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V' }
  const a = /^(\d+[A-Z]*?)(?:M(\d))?$/i.exec(sony)
  if (!a) return sony.toUpperCase()
  return `A${a[1].toUpperCase()}${a[2] ? ` ${romano[a[2]] || `M${a[2]}`}` : ''}`
}

async function primeiroXml(dir, fs) {
  let nomes = []
  try {
    nomes = await fs.readdir(dir)
  } catch {
    return null
  }
  // O mais recente pelo nome (C0001 → C0123): se o cartão rodou em mais de um corpo, vale o último.
  const xmls = nomes.filter((n) => /\.xml$/i.test(n) && !n.startsWith('.')).sort().reverse()
  for (const n of xmls.slice(0, 3)) {
    try {
      const fh = await fs.open(path.join(dir, n), 'r')
      try {
        const buf = Buffer.alloc(XML_MAX)
        const { bytesRead } = await fh.read(buf, 0, XML_MAX, 0)
        const r = lerXmlSony(buf.subarray(0, bytesRead).toString('utf8'))
        if (r) return r
      } finally {
        await fh.close().catch(() => {})
      }
    } catch {}
  }
  return null
}

async function existe(p, fs) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * @returns {Promise<{ marca: string|null, modelo: string|null, serial: string|null, curto: string|null }>}
 */
export async function lerCamera(raiz, { fs = fsp } = {}) {
  for (const partes of PASTAS_SONY) {
    const r = await primeiroXml(path.join(raiz, ...partes), fs)
    if (r) return { ...r, curto: nomeCurto(r.modelo) }
  }
  // Sem serial: só o tipo, para sugerir o nome da câmera.
  let raizNomes = []
  try {
    raizNomes = (await fs.readdir(raiz)).map((n) => n.toUpperCase())
  } catch {}
  const tem = (n) => raizNomes.includes(n)
  let curto = null
  if (tem('PRIVATE') && (await existe(path.join(raiz, 'PRIVATE', 'M4ROOT'), fs))) curto = 'Sony'
  else if (tem('XDROOT')) curto = 'Sony'
  else if (tem('CONTENTS')) curto = 'Panasonic'
  else if (tem('DCIM')) {
    let sub = []
    try {
      sub = (await fs.readdir(path.join(raiz, 'DCIM'))).map((n) => n.toUpperCase())
    } catch {}
    if (sub.some((n) => n.endsWith('GOPRO'))) curto = 'GoPro'
    else if (sub.some((n) => n.includes('MEDIA') || n.startsWith('DJI'))) curto = 'DJI'
    else if (sub.some((n) => n.endsWith('CANON') || n.endsWith('EOS'))) curto = 'Canon'
    else if (sub.some((n) => n.endsWith('NIKON') || n.endsWith('NZ'))) curto = 'Nikon'
  } else if (raizNomes.some((n) => n.endsWith('.BRAW'))) curto = 'Blackmagic'
  return { marca: curto, modelo: null, serial: null, curto }
}
