// Processo filho de test/download-md5.test.js: retoma um download a partir do registro gravado em JSON, como o app
// fechado e aberto de novo. Nada do MD5 da execução anterior existe aqui (outro processo, Hasher novo).
// Uso: node download-retomar-filho.mjs <registro.json> <item.json> <url-da-mídia> <settings.json> <hash-cache.json>
// Saída (stdout, uma linha JSON): { record, counters, atVerify }
import fs from 'node:fs/promises'
import { DownloadTask } from '../src/engine/download.js'
import { Hasher } from '../src/engine/hasher.js'
import { Settings } from '../src/config.js'
import { BandwidthLimiter } from '../src/util/limiter.js'
import { closeHttp } from '../src/net/http.js'

const [recFile, itemFile, mediaUrl, settingsFile, cacheFile] = process.argv.slice(2)
const record = JSON.parse(await fs.readFile(recFile, 'utf8'))
const item = JSON.parse(await fs.readFile(itemFile, 'utf8'))
const settings = new Settings(settingsFile)
await settings.load()
const hasher = new Hasher({ cacheFile, workers: 1, log: () => {} })
const drive = {
  getItem: async () => item,
  mediaUrl: () => mediaUrl,
  authHeader: async () => ({ authorization: 'Bearer teste' }),
}
const ctx = { drive, settings, limiter: new BandwidthLimiter(0), hasher, persist() {}, onBytes() {}, log() {} }
const task = new DownloadTask(record, ctx, { retryBaseMs: 20 })
let atVerify = null
task.on('status', s => {
  if (s === 'verifying') atVerify = task.verifyBytes
})
let error = null
try {
  await task.run()
} catch (err) {
  error = { message: err?.message, reason: err?.reason, kind: err?.kind }
}
await hasher.close()
await closeHttp()
process.stdout.write(JSON.stringify({ record, counters: task.counters, atVerify, error }) + '\n')
