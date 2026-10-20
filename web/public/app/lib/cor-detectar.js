// Que perfil de cor o vídeo tem? Primeiro pelos metadados que a câmera grava dentro do arquivo (a Sony põe um XML
// com "CaptureGammaEquation" = s-log3-cine; Panasonic, Canon, DJI, ARRI e Fuji escrevem o nome do LOG), lendo só o
// começo e o fim do arquivo. Sem metadado, pela imagem: LOG tem preto levantado, branco baixo e pouca saturação.
// Este arquivo é o mesmo em src/cor/detectar.js e web/public/app/lib/cor-detectar.js (o celular detecta no aparelho).

export const PEDACO = 384 * 1024

const latin1 = new TextDecoder('latin1')

/** Procura o perfil no texto dos metadados (bytes lidos como latin1). Devolve o id em PERFIS (cor-lut) ou null. */
export function perfilDosBytes(buf) {
  const s = buf instanceof Uint8Array ? latin1.decode(buf) : String(buf || '')
  // Sony: o XML diz a curva e o gamut.
  const gama = /CaptureGammaEquation"?\s*(?:value=)?"([^"]{1,40})"/i.exec(s)?.[1]?.toLowerCase()
  const prim = /CaptureColorPrimaries"?\s*(?:value=)?"([^"]{1,40})"/i.exec(s)?.[1]?.toLowerCase()
  if (gama) {
    if (/s-?log3/.test(gama)) return /cine/.test(gama) || /cine/.test(prim || '') || !prim ? 'slog3-cine' : 'slog3'
    if (/rec709|itu709|bt\.?709|hlg|s-cinetone/.test(gama)) return 'rec709'
  }
  if (/s-?gamut3[._-]?cine/i.test(s)) return 'slog3-cine'
  if (/s-?log3/i.test(s)) return /s-?gamut3(?![._-]?cine)/i.test(s) ? 'slog3' : 'slog3-cine'
  // Os nomes como as câmeras escrevem (com hífen e maiúsculas): "vlog" num título de vídeo não é V-Log.
  if (/\bV-Log\b|V-Gamut/.test(s)) return 'vlog'
  if (/canon\s?log\s?3|\bc-log\s?3\b/i.test(s)) return 'clog3'
  if (/\bD-Log\b/.test(s)) return 'dlog'
  if (/\bLog-?C3?\b|\bALEXA\b/.test(s)) return 'logc3'
  if (/\bF-Log2?\b/.test(s)) return 'flog'
  return null
}

/**
 * Pela imagem (amostras RGB 0–255): em LOG o branco quase nunca sobe (os 2% mais claros ficam abaixo de ~75%; em
 * Rec.709 passam de ~77%) e a cor é lavada. Vale a maioria dos quadros. Devolve 'log' (genérico) ou null.
 * Uma cena toda escura e sem cor pode enganar: por isso só sugere, e os metadados vêm antes.
 * @param {Uint8Array[]} quadros RGB (rgb24)
 */
export function pareceLog(quadros) {
  if (!quadros?.length) return null
  let votos = 0
  for (const q of quadros) {
    const lumas = []
    let sat = 0
    let n = 0
    for (let i = 0; i + 2 < q.length; i += 3 * 7) {
      const r = q[i] / 255
      const g = q[i + 1] / 255
      const b = q[i + 2] / 255
      const mx = Math.max(r, g, b)
      lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b)
      sat += mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0
      n++
    }
    lumas.sort((a, b) => a - b)
    const branco = lumas[Math.floor(0.98 * (lumas.length - 1))]
    const media = lumas[Math.floor(0.5 * (lumas.length - 1))]
    if (branco < 0.75 && branco > 0.25 && media > 0.04 && sat / n < 0.45) votos++
  }
  return votos / quadros.length >= 0.6 ? 'log' : null
}
