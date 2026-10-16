// Ponte da barra do navegador de referências (desktop/navegador.js). Só a nossa barra recebe isto; a página dos
// sites (Instagram, YouTube…) não tem preload nenhum.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('navegador', {
  desktop: true,
  platform: process.platform,
  ir: texto => ipcRenderer.invoke('navegador:ir', String(texto || '')),
  acao: nome => ipcRenderer.invoke('navegador:acao', String(nome || '')),
  painel: aberto => ipcRenderer.invoke('navegador:painel', Boolean(aberto)),
  estado: () => ipcRenderer.invoke('navegador:estado'),
  abrirFora: url => ipcRenderer.invoke('navegador:abrir-fora', String(url || '')),
  sairDasContas: () => ipcRenderer.invoke('navegador:sair-das-contas'),
  aoEstado: fn => {
    const h = (_e, s) => fn(s)
    ipcRenderer.on('navegador:estado', h)
    return () => ipcRenderer.removeListener('navegador:estado', h)
  },
  aoSalvar: fn => {
    const h = (_e, d) => fn(d)
    ipcRenderer.on('navegador:salvar', h)
    return () => ipcRenderer.removeListener('navegador:salvar', h)
  },
})
