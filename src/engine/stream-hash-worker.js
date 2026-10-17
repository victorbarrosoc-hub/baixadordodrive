// Worker do MD5 que acompanha um download (Hasher.stream): lê do DISCO, em ordem, o que o download já gravou.
// O motor avisa até onde é seguro ler ("frente contínua": tudo antes dela já foi gravado e não muda mais nesta
// rodada); o worker lê esse trecho pelo seu próprio descritor (dado recém-gravado, ainda no cache do sistema) e
// alimenta o MD5. O hash cobre os bytes que estão no arquivo, nunca os que vieram da rede.
//
// Um worker por download (não usa o pool do Hasher: ficaria ocupado a transferência inteira, quase sempre esperando).
// Leitura síncrona: não ocupa as threads do libuv que as gravações e o fdatasync do motor usam.
//
// Protocolo:
//   entrada: { type: 'advance', upto } | { type: 'finish', size } | { type: 'close' } (fecha o arquivo e sai)
//   saída:   { type: 'progress', bytes } (no máximo a cada 200 ms) | { type: 'done', md5, bytes }
//            | { type: 'error', error: { code, message, errno, syscall, path } }
import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import crypto from 'node:crypto'

const CHUNK = 4 * 1024 * 1024
const PROGRESS_MS = 200

const md5 = crypto.createHash('md5')
const buf = Buffer.allocUnsafe(CHUNK)
let fd = null
let pos = 0 // bytes já no MD5
let limit = 0 // até onde é seguro ler
let target = null // tamanho final (depois do 'finish')
let pumping = false
let stopped = false
let lastProgress = 0

function fail(err) {
  if (stopped) return
  stopped = true
  closeFd()
  parentPort.postMessage({
    type: 'error',
    error: { code: err?.code, message: err?.message || String(err), errno: err?.errno, syscall: err?.syscall, path: err?.path },
  })
}

function closeFd() {
  if (fd == null) return
  try {
    fs.closeSync(fd)
  } catch {}
  fd = null
}

async function pump() {
  if (pumping || stopped) return
  pumping = true
  try {
    while (!stopped && pos < limit) {
      const want = Math.min(CHUNK, limit - pos)
      const n = fs.readSync(fd, buf, 0, want, pos)
      if (n <= 0) throw Object.assign(new Error('O arquivo temporário terminou antes do esperado.'), { code: 'ESHORT' })
      md5.update(buf.subarray(0, n))
      pos += n
      const now = Date.now()
      if (now - lastProgress >= PROGRESS_MS) {
        lastProgress = now
        parentPort.postMessage({ type: 'progress', bytes: pos })
      }
      // Deixa as mensagens do motor (avanço, fim, fechar) chegarem entre um bloco e outro.
      await new Promise(resolve => setImmediate(resolve))
    }
    if (!stopped && target != null && pos === target) {
      stopped = true
      closeFd()
      parentPort.postMessage({ type: 'progress', bytes: pos })
      parentPort.postMessage({ type: 'done', md5: md5.digest('hex'), bytes: pos })
    }
  } catch (err) {
    fail(err)
  } finally {
    pumping = false
  }
}

// Abre já ao nascer (o motor acabou de abrir o temporário): fica preso ao mesmo arquivo que o download grava, mesmo
// que alguém troque o que está no caminho depois.
try {
  fd = fs.openSync(workerData.path, 'r')
} catch (err) {
  fail(err)
}

parentPort.on('message', msg => {
  if (msg?.type === 'close') {
    // Fecha o descritor ANTES de sair: terminate() não fecha descritores abertos pelo worker (no Windows, um
    // descritor esquecido segura o temporário).
    stopped = true
    closeFd()
    parentPort.close()
    return
  }
  if (stopped) return
  if (msg?.type === 'advance') {
    const upto = Number(msg.upto)
    if (!Number.isSafeInteger(upto) || upto < 0) return fail(new Error('Avanço inválido do MD5.'))
    if (target != null && upto > target) return fail(new Error('Avanço do MD5 além do fim do arquivo.'))
    if (upto > limit) limit = upto
    pump()
  } else if (msg?.type === 'finish') {
    const size = Number(msg.size)
    if (!Number.isSafeInteger(size) || size < limit) return fail(new Error('Fim do MD5 antes do que já foi lido.'))
    target = size
    limit = size
    pump()
  }
})
