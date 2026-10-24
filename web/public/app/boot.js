// Antes de tudo (no <head>): aberto pela Tela de Início do iPhone, com a barra de status no estilo "default", a tela do
// app começa abaixo da barra, mas a imagem de abertura do sistema (icons/splash) ocupa a tela inteira. Para o símbolo
// do carregamento (.boot) e da abertura (lib/abertura.js) ficarem no mesmo lugar da imagem, eles sobem metade da
// altura da barra (--sb-meio). Fora disso (navegador, Android, de lado): 0.
;(function () {
  try {
    var falta = screen.height - window.innerHeight
    var meio = window.navigator.standalone === true && falta > 0 && falta < 120 ? falta / 2 : 0
    document.documentElement.style.setProperty('--sb-meio', meio + 'px')
  } catch (e) {}
})()
