// Abertura (Versão 1, "Sobe e desce"): ao abrir o app, o quadrado se forma girando, a barra violeta sobe, a azul desce,
// o nome entra letra por letra no sentido de cada metade (SOBE subindo, DESCE descendo), as barras dão um pulo e o app
// aparece por baixo. Igual à prévia aprovada, no computador e no celular.
// O mesmo arquivo vive no app do computador (public/lib/) e no do celular (web/public/app/lib/): mantenha os dois iguais
// (test/abertura.test.js confere).
//   - Computador: uma vez por abertura do programa (recarregar na mesma sessão não repete: sessionStorage).
//   - Celular (`sempre`): toda vez que o app abre, e de novo quando ele volta para a tela depois de um tempo fora
//     (tocar no ícone com o app em segundo plano: aberturaAoVoltar). A imagem de abertura do iPhone (icons/splash) e o
//     carregamento do index.html (.boot) são só o fundo: a animação começa do vazio, como na prévia.
//   - A animação só começa depois que a tela foi desenhada (dois quadros) e com o app à vista: até lá fica parada no
//     primeiro quadro (fundo liso), em vez de correr escondida.
//   - Fica por cima até o app estar pronto (`pronto`: no celular, a conta respondeu). Se demorar, as barras seguem num
//     sobe e desce suave; a tela de "carregando" do app não chega a aparecer. No máximo ~8 s.
//   - Um toque, clique ou tecla pula na hora.
//   - Sem Web Animations: não mostra nada.
//   - O visual fica em lib/abertura.css, ligado no index.html de cada app: o site do celular não aceita <style> criado
//     pelo código (Content-Security-Policy style-src 'self'); com ele, a camada ficava sem estilo e invisível.
// O símbolo é o do favicon (viewBox 24: quadrado rx 7; barras de 3,6 em x 9 e x 15).

const CHAVE = 'sobedesce.abertura'
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const SAI = 'cubic-bezier(0.55, 0, 0.75, 0.2)'
const ESPERA_MS = 4500 // quanto a abertura segura esperando o app ficar pronto
const MAX_MS = 8000

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

let ativa = false // uma camada por vez (voltar ao app no meio da abertura não empilha outra)

/**
 * Mostra a abertura.
 * @param {{ tamanho?: number, sempre?: boolean, pronto?: Promise<unknown> }} o
 *   tamanho: lado do símbolo em px. sempre: toda vez (celular), sem a trava de uma vez por sessão. pronto: resolve
 *   quando o app pode aparecer (a saída espera por ela).
 */
export function abertura({ tamanho = 84, sempre = false, pronto = Promise.resolve() } = {}) {
  if (typeof document === 'undefined' || !document.body || ativa || (!sempre && jaMostrou())) return
  if (typeof Element.prototype.animate !== 'function') return
  ativa = true
  marcar()

  const camada = el('div', 'ab-camada', document.body)
  camada.setAttribute('aria-hidden', 'true')
  camada.style.setProperty('--ab-s', `${tamanho}px`)
  const lk = el('div', 'ab-lockup', camada)
  const mk = el('div', 'ab-mk', lk)
  el('i', 'ab-q', mk)
  const up = el('i', 'ab-bar ab-up', mk)
  const down = el('i', 'ab-bar ab-down', mk)
  const wm = el('div', 'ab-wm', lk)
  const letras = [...'SOBEDESCE'].map((c, k) => {
    const s = el('span', k < 4 ? 'ab-f' : 'ab-r', wm)
    s.textContent = c
    return s
  })

  // Tudo é criado parado no primeiro quadro e só anda depois que a tela foi desenhada (ver tocar()).
  const anims = []
  const a = (e, kf, o) => {
    const x = e.animate(kf, { fill: 'both', easing: EASE, ...o })
    x.pause()
    anims.push(x)
    return x
  }
  let saindo = false
  let terminou = false
  const tirar = () => {
    if (terminou) return
    terminou = true
    ativa = false
    clearTimeout(seguranca)
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, pular, true)
    camada.remove()
  }
  // Pular: a animação para onde está e a camada sai num esmaecer curto.
  const pular = () => {
    if (saindo || terminou) return
    saindo = true
    for (const x of camada.getAnimations({ subtree: true })) x.pause()
    camada.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: SAI, fill: 'forwards' }).finished.then(tirar, tirar)
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, pular, { capture: true, passive: true })
  let seguranca = 0
  let miolo = 0 // quando o miolo da animação acaba (depois disso: esperar o app e sair)
  // Esperando o app: as barras seguem num sobe e desce suave (a violeta sobe, a azul desce), em laço.
  const esperando = () => [
    up.animate([{ translate: '0 0' }, { translate: `0 ${-tamanho * 0.07}px` }], { duration: 520, easing: 'ease-in-out', direction: 'alternate', iterations: Infinity }),
    down.animate([{ translate: '0 0' }, { translate: `0 ${tamanho * 0.07}px` }], { duration: 520, delay: 120, easing: 'ease-in-out', direction: 'alternate', iterations: Infinity }),
  ]
  const sair = () => {
    if (saindo || terminou) return
    saindo = true
    lk.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }], { duration: 480, easing: SAI, fill: 'forwards' })
    const f = camada.animate([{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(6px)' }], { delay: 20, duration: 420, easing: SAI, fill: 'forwards' })
    f.finished.then(tirar, tirar)
  }
  const tocar = async () => {
    if (saindo || terminou) return
    seguranca = setTimeout(tirar, MAX_MS)
    for (const x of anims) x.play()
    let pronta = false
    const ok = Promise.resolve(pronto).then(() => (pronta = true), () => (pronta = true))
    await new Promise((r) => setTimeout(r, miolo))
    if (saindo || terminou) return
    if (!pronta) {
      const laco = esperando()
      await Promise.race([ok, new Promise((r) => setTimeout(r, ESPERA_MS))])
      for (const x of laco) x.cancel()
    }
    sair()
  }

  const s = tamanho
  a(mk, [{ transform: 'scale(.4) rotate(-12deg)', opacity: 0 }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }], { delay: 60, duration: 620, easing: SPRING })
  a(up, [{ transform: 'translateY(60%) scaleY(0)', transformOrigin: '50% 100%' }, { transform: 'translateY(0) scaleY(1)', transformOrigin: '50% 100%' }], { delay: 280, duration: 560, easing: SPRING })
  a(down, [{ transform: 'translateY(-60%) scaleY(0)', transformOrigin: '50% 0%' }, { transform: 'translateY(0) scaleY(1)', transformOrigin: '50% 0%' }], { delay: 380, duration: 560, easing: SPRING })
  faiscas(a, mk, s, 620)
  letras.forEach((l, k) => {
    a(l, [{ transform: `translateY(${k < 4 ? 70 : -70}%)`, opacity: 0, filter: 'blur(4px)' }, { transform: 'translateY(0)', opacity: 1, filter: 'blur(0)' }], { delay: 720 + k * 42, duration: 520, easing: SPRING })
  })
  pulo(a, up, down, s, 1300)
  miolo = 1600

  // Dois quadros: o app desenha a tela (o render vem logo depois desta função) e a camada aparece parada; aí anda.
  // Com o app escondido (o iPhone ainda abrindo) o navegador não desenha quadros: espera ele aparecer.
  requestAnimationFrame(() => requestAnimationFrame(tocar))
}

/**
 * Celular: repete a abertura quando o app volta para a tela depois de `foraMs` em segundo plano (tocar no ícone com o
 * app ainda aberto não recarrega a página).
 */
export function aberturaAoVoltar(opcoes = {}, foraMs = 2000) {
  if (typeof document === 'undefined') return
  let saiu = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saiu = Date.now()
      return
    }
    const fora = saiu ? Date.now() - saiu : 0
    saiu = 0
    if (fora >= foraMs) abertura({ ...opcoes, sempre: true })
  })
}

/** As faíscas: uma sobe violeta, outra desce azul. */
function faiscas(a, mk, s, t) {
  const f1 = el('i', 'ab-faisca', mk)
  Object.assign(f1.style, { left: `${(s * 8.6) / 24}px`, top: `${(s * 4) / 24}px`, background: '#9b85ff' })
  const f2 = el('i', 'ab-faisca', mk)
  Object.assign(f2.style, { left: `${(s * 14.6) / 24}px`, top: `${(s * 18.5) / 24}px`, background: '#3d9cff' })
  a(f1, [{ transform: 'translateY(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translateY(${-s * 0.9}px)`, opacity: 0 }], { delay: t, duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' })
  a(f2, [{ transform: 'translateY(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translateY(${s * 0.9}px)`, opacity: 0 }], { delay: t + 80, duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' })
}

/** O pulo: a violeta sobe, a azul desce, uma vez. */
function pulo(a, up, down, s, t) {
  a(up, [{ translate: '0 0' }, { translate: `0 ${-s * 0.08}px`, offset: 0.45 }, { translate: '0 0' }], { delay: t, duration: 420, easing: 'ease-in-out' })
  a(down, [{ translate: '0 0' }, { translate: `0 ${s * 0.08}px`, offset: 0.45 }, { translate: '0 0' }], { delay: t + 40, duration: 420, easing: 'ease-in-out' })
}
