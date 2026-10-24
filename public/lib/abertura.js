// Abertura (Versão 1, "Sobe e desce"): ao abrir o app, o símbolo se forma, a barra violeta sobe, a azul desce, o nome
// entra letra por letra (SOBE subindo, DESCE descendo), as barras dão um pulo e o app aparece por baixo.
// O mesmo arquivo vive no app do computador (public/lib/) e no do celular (web/public/app/lib/): mantenha os dois iguais.
//   - Uma vez por abertura: recarregar a página na mesma sessão não repete (sessionStorage).
//   - Um toque, clique ou tecla pula na hora; o app já carrega por trás (a camada fica por cima e some no fim).
//   - "Reduzir movimento": só um esmaecer curto do símbolo.
//   - Sem Web Animations ou com a aba escondida: não mostra nada.
// O símbolo é o do favicon (viewBox 24: quadrado rx 7; barras de 3,6 em x 9 e x 15).

const CHAVE = 'sobedesce.abertura'
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const SAI = 'cubic-bezier(0.55, 0, 0.75, 0.2)'
const MAX_MS = 3500

const CSS = `
.ab-camada{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:var(--bg,#0b0b0c);color:var(--text,#f5f5f7);cursor:default;-webkit-user-select:none;user-select:none}
.ab-lockup{display:grid;justify-items:center;gap:calc(var(--ab-s) * 0.28)}
.ab-mk{position:relative;width:var(--ab-s);height:var(--ab-s);border-radius:calc(var(--ab-s) * 7 / 24);background:#111113;box-shadow:0 0 0 1px rgba(255,255,255,.06) inset,0 18px 40px -18px rgba(17,17,19,.55)}
.ab-bar{position:absolute;width:calc(var(--ab-s) * 3.6 / 24);height:calc(var(--ab-s) * 11.6 / 24);border-radius:99px}
.ab-up{left:calc(var(--ab-s) * 7.2 / 24);top:calc(var(--ab-s) * 4.7 / 24);background:#9b85ff}
.ab-down{left:calc(var(--ab-s) * 13.2 / 24);top:calc(var(--ab-s) * 7.7 / 24);background:#3d9cff}
.ab-faisca{position:absolute;width:calc(var(--ab-s) * 0.09);height:calc(var(--ab-s) * 0.09);border-radius:50%;opacity:0}
.ab-wm{display:flex;font-family:var(--font-display,-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,sans-serif);font-size:calc(var(--ab-s) * 0.34);letter-spacing:.14em;line-height:1;white-space:nowrap}
.ab-wm span{display:inline-block}
.ab-f{font-weight:750}
.ab-r{font-weight:300}
`

function el(tag, cls, pai) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (pai) pai.appendChild(e)
  return e
}

function jaMostrou() {
  try {
    return sessionStorage.getItem(CHAVE) === '1'
  } catch {
    return false
  }
}

function marcar() {
  try {
    sessionStorage.setItem(CHAVE, '1')
  } catch {}
}

/**
 * Mostra a abertura (uma vez por sessão).
 * @param {{ tamanho?: number, quadradoPronto?: boolean }} o
 *   tamanho: lado do símbolo em px. quadradoPronto: o quadrado já começa no lugar (no iPhone, a imagem de abertura do
 *   sistema já mostrou o símbolo nesse tamanho e posição; só as barras e o nome se animam).
 */
export function abertura({ tamanho = 84, quadradoPronto = false } = {}) {
  if (typeof document === 'undefined' || !document.body || jaMostrou()) return
  if (document.visibilityState === 'hidden' || typeof Element.prototype.animate !== 'function') return
  marcar()
  const reduzir = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const estilo = el('style', null, document.head)
  estilo.textContent = CSS
  const camada = el('div', 'ab-camada', document.body)
  camada.setAttribute('aria-hidden', 'true')
  camada.style.setProperty('--ab-s', `${tamanho}px`)
  const lk = el('div', 'ab-lockup', camada)
  const mk = el('div', 'ab-mk', lk)
  const up = el('i', 'ab-bar ab-up', mk)
  const down = el('i', 'ab-bar ab-down', mk)
  const wm = el('div', 'ab-wm', lk)
  const letras = [...'SOBEDESCE'].map((c, k) => {
    const s = el('span', k < 4 ? 'ab-f' : 'ab-r', wm)
    s.textContent = c
    return s
  })

  const anims = []
  const a = (e, kf, o) => {
    const x = e.animate(kf, { fill: 'both', easing: EASE, ...o })
    anims.push(x)
    return x
  }
  let fim = null
  let saindo = false
  let terminou = false
  const tirar = () => {
    if (terminou) return
    terminou = true
    clearTimeout(seguranca)
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, pular, true)
    camada.remove()
    estilo.remove()
  }
  // Pular: a animação para onde está e a camada sai num esmaecer curto.
  const pular = () => {
    if (saindo || terminou) return
    saindo = true
    fim?.cancel()
    for (const x of anims) x.pause()
    camada.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: SAI, fill: 'forwards' }).finished.then(tirar, tirar)
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, pular, { capture: true, passive: true })
  const seguranca = setTimeout(tirar, MAX_MS)

  if (reduzir) {
    a(lk, [{ opacity: 0 }, { opacity: 1 }], { duration: 220 })
    fim = camada.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 650, duration: 260, easing: SAI, fill: 'forwards' })
    fim.finished.then(tirar, () => {}) // cancelada = pulou: quem tira é o pular
    return
  }

  const t = quadradoPronto ? -160 : 0 // sem a entrada do quadrado, tudo começa um pouco antes
  if (!quadradoPronto) a(mk, [{ transform: 'scale(.4) rotate(-12deg)', opacity: 0 }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }], { delay: 60, duration: 620, easing: SPRING })
  a(up, [{ transform: 'translateY(60%) scaleY(0)', transformOrigin: '50% 100%' }, { transform: 'translateY(0) scaleY(1)', transformOrigin: '50% 100%' }], { delay: 280 + t, duration: 560, easing: SPRING })
  a(down, [{ transform: 'translateY(-60%) scaleY(0)', transformOrigin: '50% 0%' }, { transform: 'translateY(0) scaleY(1)', transformOrigin: '50% 0%' }], { delay: 380 + t, duration: 560, easing: SPRING })
  // as faíscas: uma sobe violeta, outra desce azul
  const s = tamanho
  const f1 = el('i', 'ab-faisca', mk)
  Object.assign(f1.style, { left: `${(s * 8.6) / 24}px`, top: `${(s * 4) / 24}px`, background: '#9b85ff' })
  const f2 = el('i', 'ab-faisca', mk)
  Object.assign(f2.style, { left: `${(s * 14.6) / 24}px`, top: `${(s * 18.5) / 24}px`, background: '#3d9cff' })
  a(f1, [{ transform: 'translateY(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translateY(${-s * 0.9}px)`, opacity: 0 }], { delay: 620 + t, duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' })
  a(f2, [{ transform: 'translateY(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translateY(${s * 0.9}px)`, opacity: 0 }], { delay: 700 + t, duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' })
  letras.forEach((l, k) => {
    a(l, [{ transform: `translateY(${k < 4 ? 70 : -70}%)`, opacity: 0, filter: 'blur(4px)' }, { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' }], { delay: 720 + t + k * 42, duration: 520, easing: SPRING })
  })
  // o pulo: sobe e desce uma vez
  a(up, [{ translate: '0 0' }, { translate: `0 ${-s * 0.08}px`, offset: 0.45 }, { translate: '0 0' }], { delay: 1300 + t, duration: 420, easing: 'ease-in-out' })
  a(down, [{ translate: '0 0' }, { translate: `0 ${s * 0.08}px`, offset: 0.45 }, { translate: '0 0' }], { delay: 1340 + t, duration: 420, easing: 'ease-in-out' })
  a(lk, [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }], { delay: 1600 + t, duration: 480, easing: SAI })
  fim = camada.animate([{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(6px)' }], { delay: 1620 + t, duration: 420, easing: SAI, fill: 'forwards' })
  fim.finished.then(tirar, () => {}) // cancelada = pulou: quem tira é o pular
}
