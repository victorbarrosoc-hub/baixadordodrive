// Ponte entre a interface (página web) e o Mac/Windows. Só expõe o mínimo, sem dar Node à página.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('sobedesce', {
  desktop: true,
  platform: process.platform,
  pickFolder: (opts = {}) => ipcRenderer.invoke('sobedesce:pick-folder', opts),
  pickPaths: (opts = {}) => ipcRenderer.invoke('sobedesce:pick-paths', opts),
  pathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  setProgress: (fraction, activeCount) => ipcRenderer.send('sobedesce:progress', { fraction, activeCount }),
  notify: (title, body) => ipcRenderer.send('sobedesce:notify', { title, body }),
  openExternal: url => ipcRenderer.invoke('sobedesce:open-external', url),
  reveal: path => ipcRenderer.invoke('sobedesce:reveal', path),
  // macOS: abre Ajustes do Sistema na Rede Local ou no Firewall (o Wi-Fi com o celular precisa dos dois liberados).
  abrirAjustesRede: qual => ipcRenderer.invoke('sobedesce:abrir-ajustes-rede', qual === 'firewall' ? 'firewall' : 'rede-local'),
  // Referências: abre o navegador de referências (janela própria; desktop/navegador.js).
  abrirNavegador: url => ipcRenderer.invoke('sobedesce:abrir-navegador', url || null),
})
