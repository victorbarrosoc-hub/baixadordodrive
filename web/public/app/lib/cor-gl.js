// LOG → Rec.709 na prévia: cada quadro do <video> passa pela LUT 3D do perfil (a mesma do motor, cor-lut.js) na placa
// de vídeo, num <canvas> por cima do vídeo. Não mexe no arquivo, só no que se vê. Sem WebGL2: devolve null e a prévia
// fica como está. Este arquivo é o mesmo em public/lib/cor-gl.js e web/public/app/lib/cor-gl.js (test/cor.test.js).
import { gerarLut } from './cor-lut.js'

const N = 33
const MAX_LADO = 1920

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`

// A coordenada na LUT vai do centro da primeira célula ao centro da última (como no .cube).
const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D quadro;
uniform sampler3D lut;
in vec2 uv;
out vec4 cor;
void main() {
  vec3 c = clamp(texture(quadro, uv).rgb, 0.0, 1.0);
  cor = vec4(texture(lut, c * ${((N - 1) / N).toFixed(8)} + ${(0.5 / N).toFixed(8)}).rgb, 1.0);
}`

function compilar(gl, tipo, src) {
  const s = gl.createShader(tipo)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader')
  return s
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLVideoElement} video
 * @returns {{ perfil(p: string|null): void, fechar(): void } | null}
 */
export function filtroCor(canvas, video) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false })
  if (!gl) return null
  let prog
  try {
    prog = gl.createProgram()
    gl.attachShader(prog, compilar(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compilar(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link')
  } catch {
    return null
  }
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const texQuadro = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texQuadro)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v)
  gl.uniform1i(gl.getUniformLocation(prog, 'quadro'), 0)

  const texLut = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_3D, texLut)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v)
  gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1)

  let atual = null
  let vivo = true
  let pedido = 0
  const luts = new Map()

  const desenhar = () => {
    if (!vivo || !atual || video.readyState < 2 || !video.videoWidth) return
    // Até 1920 px no lado maior: um 4K inteiro pesa na placa do celular e não aparece na tela da prévia.
    const esc = Math.min(1, MAX_LADO / Math.max(video.videoWidth, video.videoHeight))
    const w = Math.round(video.videoWidth * esc)
    const h = Math.round(video.videoHeight * esc)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texQuadro)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    } catch {
      return
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    canvas.dataset.pronto = '1' // até o primeiro quadro, o poster do vídeo continua aparecendo
  }
  // Um quadro novo do vídeo (tocando, depois de pular, passo a passo): desenha. Sem requestVideoFrameCallback, a cada tela.
  const rvfc = typeof video.requestVideoFrameCallback === 'function'
  const laco = () => {
    if (!vivo || !atual) return
    desenhar()
    pedido = rvfc ? video.requestVideoFrameCallback(laco) : requestAnimationFrame(laco)
  }
  const parar = () => {
    if (!pedido) return
    if (rvfc) video.cancelVideoFrameCallback(pedido)
    else cancelAnimationFrame(pedido)
    pedido = 0
  }
  // Pausado e pulando: o rVFC chega; 'seeked' e 'loadeddata' garantem o quadro mesmo sem ele.
  const ev = ['seeked', 'loadeddata']
  for (const e of ev) video.addEventListener(e, desenhar)

  return {
    perfil(p) {
      atual = p || null
      parar()
      if (!atual) return
      if (!luts.has(atual)) luts.set(atual, gerarLut(atual, N))
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_3D, texLut)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, N, N, N, 0, gl.RGB, gl.FLOAT, luts.get(atual))
      desenhar()
      laco()
    },
    fechar() {
      vivo = false
      parar()
      for (const e of ev) video.removeEventListener(e, desenhar)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
