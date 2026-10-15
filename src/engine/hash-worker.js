// Código do worker de MD5: lê o arquivo em blocos de 4 MiB e devolve o hash, sem travar o motor.
// Protocolo (mensagens):
//   entrada: { type: 'hash', id, path } | { type: 'cancel', id }
//   saída:   { type: 'progress', id, bytes } (no máximo a cada 200 ms)
//            { type: 'done', id, md5, bytes } | { type: 'error', id, error: { code, message, errno, syscall, path } }
//            { type: 'canceled', id } (depois que o arquivo foi fechado)
import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import crypto from 'node:crypto'

const CHUNK = 4 * 1024 * 1024
const PROGRESS_MS = 200

let current = null // { id, stream, canceled }

parentPort.on('message', msg => {
  if (msg?.type === 'hash') start(msg)
  else if (msg?.type === 'cancel') cancel(msg.id)
})

function start({ id, path }) {
  const md5 = crypto.createHash('md5')
  const job = { id, stream: null, canceled: false, finished: false }
  current = job
  let bytes = 0
  let last = Date.now()

  const finish = msg => {
    if (job.finished) return
    job.finished = true
    if (current === job) current = null
    parentPort.postMessage(msg)
  }

  const stream = fs.createReadStream(path, { highWaterMark: CHUNK })
  job.stream = stream
  stream.on('data', chunk => {
    if (job.canceled) return
    md5.update(chunk)
    bytes += chunk.length
    const now = Date.now()
    if (now - last >= PROGRESS_MS) {
      last = now
      parentPort.postMessage({ type: 'progress', id, bytes })
    }
  })
  stream.on('end', () => {
    if (!job.canceled) finish({ type: 'done', id, md5: md5.digest('hex'), bytes })
  })
  stream.on('error', err => {
    if (job.canceled) return
    finish({
      type: 'error',
      id,
      error: { code: err.code, message: err.message, errno: err.errno, syscall: err.syscall, path: err.path },
    })
  })
  // Só avisa o cancelamento quando o descritor já foi fechado.
  stream.on('close', () => {
    if (job.canceled) finish({ type: 'canceled', id })
  })
}

function cancel(id) {
  const job = current
  if (!job || job.id !== id || job.finished || job.canceled) return
  job.canceled = true
  job.stream.destroy()
}
