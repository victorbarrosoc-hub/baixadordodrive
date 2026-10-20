// Worker da cópia entre discos: recebe um arquivo por vez do serviço (servico.js) e devolve o resultado. Os bytes
// copiados/conferidos vão em avisos de no máximo 10 por segundo.
import { parentPort } from 'node:worker_threads'
import { CopiaCancelada, copiarArquivo } from './copiar.js'

let cancelado = false
let pendente = { copiando: 0, conferindo: 0 }
let ultimo = 0
const avisar = (forcar = false) => {
  const agora = Date.now()
  if (!forcar && agora - ultimo < 100) return
  ultimo = agora
  if (!pendente.copiando && !pendente.conferindo) return
  parentPort.postMessage({ tipo: 'bytes', ...pendente })
  pendente = { copiando: 0, conferindo: 0 }
}

parentPort.on('message', async (m) => {
  if (m.tipo === 'cancelar') {
    cancelado = true
    return
  }
  if (m.tipo !== 'copiar') return
  try {
    const r = await copiarArquivo({
      origem: m.origem,
      destinos: m.destinos,
      mtimeMs: m.mtimeMs,
      conferir: m.conferir,
      parar: () => cancelado,
      onBytes: (n, fase) => {
        pendente[fase] += n
        avisar()
      },
    })
    avisar(true)
    parentPort.postMessage({ tipo: 'feito', id: m.id, ...r })
  } catch (err) {
    avisar(true)
    parentPort.postMessage({ tipo: 'erro', id: m.id, cancelado: err instanceof CopiaCancelada, erro: err.code ? `${err.code}: ${err.message}` : err.message, codigo: err.code || null })
  }
})
