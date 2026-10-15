// Antes de a página pintar: aplica o tema salvo (evita piscar claro→escuro) e marca o app de desktop
// (a ponte `window.sobedesce` vem do preload do Electron), para a barra de título já nascer no lugar.
// Script clássico, sem módulos.
;(function () {
  var root = document.documentElement
  try {
    var t = JSON.parse(localStorage.getItem('sobedesce.theme') || '"system"')
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t)
  } catch (e) {}
  try {
    var b = window.sobedesce
    if (b && b.desktop) root.className += ' is-desktop platform-' + (b.platform || 'unknown')
  } catch (e) {}
})()
