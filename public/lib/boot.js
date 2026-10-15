// Aplica o tema salvo antes de a página pintar (evita piscar claro→escuro). Script clássico, sem módulos.
;(function () {
  try {
    var t = JSON.parse(localStorage.getItem('sobedesce.theme') || '"system"')
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
  } catch (e) {}
})()
