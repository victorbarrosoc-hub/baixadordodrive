// Worker da cópia entre discos: recebe arquivos do serviço (servico.js), vários ao mesmo tempo quando são pequenos, e
// devolve o resultado de cada um com os bytes que contou (o serviço acerta o progresso por arquivo). Os bytes em
// andamento vão em avisos de no máximo 10 por segundo, somados.
import { parentPort } from 'node:worker_threads'
import { CopiaCancelada, compararArquivos, copiarArquivo } from './copiar.js'

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
  if (m.tipo !== 'copiar' && m.tipo !== 'comparar') return
  const contados = { copiando: 0, conferindo: 0 }
  const comum = {
    origem: m.origem,
    destinos: m.destinos,
    tamanho: m.tamanho,
    algoritmo: m.algoritmo,
    parar: () => cancelado,
    onBytes: (n, fase) => {
      pendente[fase] += n
      contados[fase] += n
      avisar()
    },
  }
  try {
    const r = m.tipo === 'comparar' ? await compararArquivos(comum) : await copiarArquivo({ ...comum, mtimeMs: m.mtimeMs, conferir: m.conferir })
    avisar(true)
    parentPort.postMessage({ tipo: 'feito', id: m.id, contados, ...r })
  } catch (err) {
    avisar(true)
    parentPort.postMessage({ tipo: 'erro', id: m.id, contados, cancelado: err instanceof CopiaCancelada, erro: err.code ? `${err.code}: ${err.message}` : err.message, codigo: err.code || null })
  }
})
