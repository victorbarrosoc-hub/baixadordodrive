// Worker que grava no armazenamento do app (OPFS) o que chega do computador pelo Wi-Fi (lib/p2p.js). Fica num worker
// porque o Safari só deixa gravar em arquivo do OPFS com createSyncAccessHandle, que só existe dentro de worker.
// Mensagens: { id, op: 'testar' | 'abrir' | 'escrever' | 'fechar' | 'descartar', ... } → { id, ok, erro? }.

const abertos = new Map() // chave → { h: FileSystemSyncAccessHandle, pos }

async function pasta(caminho) {
  let d = await navigator.storage.getDirectory()
  for (const p of caminho) d = await d.getDirectoryHandle(p, { create: true })
  return d
}

async function tratar(m) {
  if (m.op === 'testar') {
    return typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype && Boolean(navigator.storage?.getDirectory)
  }
  if (m.op === 'abrir') {
    const d = await pasta(m.pasta)
    const f = await d.getFileHandle(m.nome, { create: true })
    const h = await f.createSyncAccessHandle()
    h.truncate(0)
    abertos.set(m.chave, { h, pos: 0 })
    return true
  }
  const a = abertos.get(m.chave)
  if (!a) throw new Error('Arquivo não está aberto.')
  if (m.op === 'escrever') {
    const u8 = new Uint8Array(m.dados)
    let feito = 0
    while (feito < u8.byteLength) feito += a.h.write(u8.subarray(feito), { at: a.pos + feito })
    a.pos += u8.byteLength
    return true
  }
  if (m.op === 'fechar' || m.op === 'descartar') {
    if (m.op === 'fechar') a.h.flush()
    else a.h.truncate(0)
    a.h.close()
    abertos.delete(m.chave)
    return true
  }
  throw new Error('Pedido desconhecido.')
}

self.onmessage = async (e) => {
  const m = e.data || {}
  try {
    self.postMessage({ id: m.id, ok: true, valor: await tratar(m) })
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, erro: err?.message || String(err) })
  }
}
