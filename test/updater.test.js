// "Atualizar" pelo próprio app (src/updater.js) com peças falsas: download com SHA-256, hash diferente, sem hash,
// pasta sem permissão, app fora de Aplicativos, marca de troca que falhou, os scripts de troca (o do Mac roda de
// verdade aqui, com atalhos falsos de xattr/open) e a rota /api/versao/atualizar com transferências andando.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Settings } from '../src/config.js'
import { VersionChecker } from '../src/version.js'
import { Updater, downloadTo, handoffCommand, isHandoffScript, macBundle, macScript, psQuote, shQuote, winScript } from '../src/updater.js'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, waitFor } from './helpers.js'

const SITE = 'https://sobedesce.exemplo'
const BYTES = Buffer.from('instalador falso do SOBEDESCE '.repeat(2000))
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex')
const remote = (build, extra = {}) => ({ ok: true, build, commit: 'abc1234', data: '2026-10-15T12:00:00.000Z', mac: '/baixar/mac', windows: '/baixar/windows', sha256Mac: SHA, sha256Windows: SHA, ...extra })

let dir
before(async () => {
  dir = await makeTmpDir('sobedesce-updater-')
})
after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  await closeHttp()
})

/** fetch falso: responde os bytes do instalador (ou o que `answer` mandar). */
function fakeFetch(body = BYTES) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, redirect: opts?.redirect })
    if (body instanceof Error) throw body
    return new Response(body, { headers: { 'content-length': String(body.length) } })
  }
  fn.calls = calls
  return fn
}

/**
 * Updater do Mac com tudo falso: o "Aplicativos" é uma pasta temporária, o hdiutil "monta" criando um .app,
 * o ditto copia de verdade. Devolve { up, calls, handoffs, apps, tmpRoot }.
 */
async function macUpdater(name, { fetch = fakeFetch(), canWrite = () => true, appDir, ...extra } = {}) {
  const root = path.join(dir, name)
  const apps = appDir || path.join(root, 'Applications')
  const tmpRoot = path.join(root, 'tmp')
  const stateDir = path.join(root, 'dados')
  await fs.mkdir(path.join(apps, 'SOBEDESCE.app', 'Contents', 'MacOS'), { recursive: true })
  await fs.writeFile(path.join(apps, 'SOBEDESCE.app', 'Contents', 'versao.txt'), 'antiga')
  await fs.mkdir(tmpRoot, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
  const calls = []
  const handoffs = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1]
      await fs.mkdir(path.join(mount, 'SOBEDESCE.app', 'Contents'), { recursive: true })
      await fs.writeFile(path.join(mount, 'SOBEDESCE.app', 'Contents', 'versao.txt'), 'nova')
      await fs.symlink('/Applications', path.join(mount, 'Applications')).catch(() => {})
    }
    if (cmd === 'ditto') await fs.cp(args[0], args[1], { recursive: true })
    if (cmd === '/bin/rm') await fs.rm(args[1], { recursive: true, force: true })
    return ''
  }
  const up = new Updater({
    platform: 'darwin',
    appExe: path.join(apps, 'SOBEDESCE.app', 'Contents', 'MacOS', 'SOBEDESCE'),
    appPid: 4242,
    stateDir,
    tmpRoot,
    handoff: job => handoffs.push(job),
    download: (url, file, onProgress) => downloadTo(url, file, { fetch, onProgress }),
    run,
    canWrite,
    progressMs: 0,
    ...extra,
  })
  return { up, calls, handoffs, apps, tmpRoot, stateDir }
}

const phases = up => {
  const seen = []
  up.on('change', st => {
    if (seen.at(-1) !== st.fase) seen.push(st.fase)
  })
  return seen
}

test('macBundle, handoffCommand e aspas dos scripts', () => {
  assert.equal(macBundle('/Applications/SOBEDESCE.app/Contents/MacOS/SOBEDESCE'), '/Applications/SOBEDESCE.app')
  assert.equal(macBundle('/Users/v/Apps/SOBEDESCE.app/Contents/MacOS/SOBEDESCE'), '/Users/v/Apps/SOBEDESCE.app')
  assert.equal(macBundle('/usr/local/bin/node'), null)
  assert.equal(macBundle(''), null)
  assert.deepEqual(handoffCommand('darwin', '/tmp/x/trocar.sh'), { cmd: '/bin/sh', args: ['/tmp/x/trocar.sh'] })
  const win = handoffCommand('win32', 'C:\\t\\trocar.ps1')
  assert.equal(win.cmd, 'powershell.exe')
  assert.deepEqual(win.args.slice(-2), ['-File', 'C:\\t\\trocar.ps1'])
  assert.ok(win.args.includes('Bypass'))
  assert.equal(handoffCommand('linux', '/tmp/x'), null)
  assert.equal(shQuote(`a'b c`), `'a'\\''b c'`)
  assert.equal(psQuote(`a'b`), `'a''b'`)
})

test('isHandoffScript: só o trocar.sh/.ps1 de uma pasta de atualização dentro da pasta temporária', async () => {
  const tmpRoot = path.join(dir, 'handoff-tmp')
  const ok = path.join(tmpRoot, 'sobedesce-atualizacao-abc')
  await fs.mkdir(ok, { recursive: true })
  await fs.writeFile(path.join(ok, 'trocar.sh'), '#!/bin/sh\n')
  await fs.writeFile(path.join(ok, 'outro.sh'), '#!/bin/sh\n')
  const fora = path.join(dir, 'handoff-fora', 'sobedesce-atualizacao-x')
  await fs.mkdir(fora, { recursive: true })
  await fs.writeFile(path.join(fora, 'trocar.sh'), '#!/bin/sh\n')
  assert.equal(isHandoffScript(path.join(ok, 'trocar.sh'), tmpRoot), true)
  assert.equal(isHandoffScript(path.join(ok, 'outro.sh'), tmpRoot), false)
  assert.equal(isHandoffScript(path.join(fora, 'trocar.sh'), tmpRoot), false)
  assert.equal(isHandoffScript(path.join(ok, '..', '..', 'handoff-fora', 'sobedesce-atualizacao-x', 'trocar.sh'), tmpRoot), false)
  assert.equal(isHandoffScript('trocar.sh', tmpRoot), false)
  assert.equal(isHandoffScript(path.join(ok, 'nao-existe', 'trocar.sh'), tmpRoot), false)
  assert.equal(isHandoffScript(42, tmpRoot), false)
})

test('downloadTo: segue o redirecionamento, mostra o progresso e calcula o SHA-256', async () => {
  const site = http.createServer((req, res) => {
    if (req.url === '/baixar/mac') {
      res.writeHead(302, { location: '/release/SOBEDESCE.dmg' })
      return res.end()
    }
    if (req.url === '/release/SOBEDESCE.dmg') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BYTES.length })
      return res.end(BYTES)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  try {
    const file = path.join(dir, 'baixado.dmg')
    const progress = []
    const sha = await downloadTo(`http://127.0.0.1:${site.address().port}/baixar/mac`, file, { onProgress: (got, total) => progress.push([got, total]) })
    assert.equal(sha, SHA)
    assert.deepEqual(await fs.readFile(file), BYTES)
    assert.deepEqual(progress.at(-1), [BYTES.length, BYTES.length])
    await assert.rejects(downloadTo(`http://127.0.0.1:${site.address().port}/nada`, path.join(dir, 'nada.dmg')), /404/)
  } finally {
    site.closeAllConnections?.()
    await new Promise(r => site.close(r))
  }
})

test('downloadTo: download incompleto e download parado falham', async () => {
  const curto = async () => new Response(BYTES.subarray(0, 100), { headers: { 'content-length': String(BYTES.length) } })
  await assert.rejects(downloadTo('https://x/baixar/mac', path.join(dir, 'curto.dmg'), { fetch: curto }), /incompleto/)
  const parado = async (_url, { signal }) =>
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); signal.addEventListener('abort', () => c.error(signal.reason)) } }), { headers: { 'content-length': '100' } })
  await assert.rejects(downloadTo('https://x/baixar/mac', path.join(dir, 'parado.dmg'), { fetch: parado, stallMs: 30 }), /parou de andar/)
})

test('Mac: baixa, confere, monta, copia o app novo ao lado, desmonta e entrega o script da troca', async () => {
  const fetch = fakeFetch()
  const { up, calls, handoffs, apps, tmpRoot } = await macUpdater('mac-ok', { fetch })
  const seen = phases(up)
  assert.equal(up.disponivel, true)
  const st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA.toUpperCase() })
  assert.equal(st.fase, 'reiniciando')
  assert.deepEqual(seen, ['baixando', 'conferindo', 'preparando', 'pronto', 'reiniciando'])
  assert.equal(fetch.calls[0].url, `${SITE}/baixar/mac`)
  assert.equal(fetch.calls[0].redirect, 'follow')
  assert.equal(up.status().recebido, BYTES.length)

  // hdiutil attach (sem abrir janela, só leitura) → rm -rf da sobra → ditto → hdiutil detach → xattr -cr no app novo
  const novo = path.join(apps, '.SOBEDESCE-atualizacao.app')
  assert.deepEqual(calls.map(c => c.slice(0, 2).join(' ')), ['hdiutil attach', '/bin/rm -rf', `ditto ${calls[2][1]}`, 'hdiutil detach', 'xattr -cr'])
  assert.ok(calls[0].includes('-nobrowse') && calls[0].includes('-readonly'))
  assert.equal(calls[1][2], novo)
  assert.equal(calls[2][2], novo)
  assert.equal(calls[4][2], novo)
  assert.equal(await fs.readFile(path.join(novo, 'Contents', 'versao.txt'), 'utf8'), 'nova')
  assert.equal(await fs.readFile(path.join(apps, 'SOBEDESCE.app', 'Contents', 'versao.txt'), 'utf8'), 'antiga', 'o app aberto só é trocado depois de fechar')

  assert.equal(handoffs.length, 1)
  const script = handoffs[0].script
  assert.equal(path.basename(script), 'trocar.sh')
  assert.ok(isHandoffScript(script, tmpRoot), 'o processo principal aceita o script')
  const texto = await fs.readFile(script, 'utf8')
  assert.match(texto, /PID=4242/)
  assert.match(texto, /open "\$APP"/)
  assert.equal(spawnSync('sh', ['-n', script]).status, 0, 'sh -n')
})

test('Mac: sobra de uma troca que não aconteceu (.SOBEDESCE-atualizacao.app com app.asar) é apagada pelo rm do sistema', async () => {
  const { up, calls, apps } = await macUpdater('mac-sobra')
  const novo = path.join(apps, '.SOBEDESCE-atualizacao.app')
  await fs.mkdir(path.join(novo, 'Contents', 'Resources'), { recursive: true })
  await fs.writeFile(path.join(novo, 'Contents', 'Resources', 'app.asar'), 'velho')
  const st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA })
  assert.equal(st.fase, 'reiniciando', st.erro || '')
  assert.deepEqual(calls.find(c => c[0] === '/bin/rm'), ['/bin/rm', '-rf', novo], 'o fs do Electron não apaga .app com app.asar dentro')
  assert.equal(fss.existsSync(path.join(novo, 'Contents', 'Resources', 'app.asar')), false)
  assert.equal(await fs.readFile(path.join(novo, 'Contents', 'versao.txt'), 'utf8'), 'nova')
})

test('Mac: a sobra não sai: erro claro com Baixar, sem a mensagem do sistema', async () => {
  const { up } = await macUpdater('mac-sobra-presa')
  const run = up.run
  up.run = async (cmd, args) => {
    if (cmd === '/bin/rm') throw Object.assign(new Error('rm falhou'), { stderr: 'Operation not permitted' })
    return run(cmd, args)
  }
  const st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA })
  assert.equal(st.fase, 'erro')
  assert.match(st.erro, /ficou presa.*Use Baixar/)
  assert.doesNotMatch(st.erro, /ENOTEMPTY|rmdir/)
})

test('hash diferente: não instala, apaga o download e deixa tentar de novo (não trava o Atualizar)', async () => {
  const { up, calls, handoffs, tmpRoot } = await macUpdater('mac-hash')
  let st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: 'f'.repeat(64) })
  assert.equal(st.fase, 'erro')
  assert.match(st.erro, /sendo publicada/)
  assert.match(st.erro, /de novo/)
  assert.equal(st.deNovo, true, 'passa sozinho: o aviso tenta de novo mais tarde')
  assert.equal(st.bloqueado, 0)
  assert.equal(handoffs.length, 0)
  assert.equal(calls.length, 0, 'nem chegou a montar')
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'o download foi apagado')
  assert.equal(up.podeInstalar(41), true, 'dá para tentar de novo')
  // a conferência perguntada de novo também não bate: erro, nada instalado
  st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: 'f'.repeat(64), recheck: async () => ({ build: 41, sha256: 'e'.repeat(64) }) })
  assert.equal(st.fase, 'erro')
  assert.equal(handoffs.length, 0)
  // tentar de novo com a conferência certa instala
  st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA })
  assert.equal(st.fase, 'reiniciando')
  assert.equal(handoffs.length, 1)
})

test('saiu um build mais novo depois da última conferida: pergunta de novo ao site e instala o novo', async () => {
  const { up, handoffs } = await macUpdater('mac-recheck')
  let perguntou = 0
  const st = await up.install({
    build: 41,
    url: `${SITE}/baixar/mac`,
    sha256: 'f'.repeat(64), // a conferência guardada do 41; o download já entrega o 43
    recheck: async () => (perguntou++, { build: 43, sha256: SHA }),
  })
  assert.equal(perguntou, 1)
  assert.equal(st.fase, 'reiniciando')
  assert.equal(st.build, 43)
  assert.equal(handoffs.length, 1)
})

test('sem SHA-256 publicado: recusa antes de baixar', async () => {
  const fetch = fakeFetch()
  const { up } = await macUpdater('mac-semhash', { fetch })
  assert.throws(() => up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: null }), err => err.status === 409 && /SHA-256/.test(err.message))
  assert.equal(fetch.calls.length, 0)
  assert.equal(up.status().fase, 'erro')
  assert.equal(up.podeInstalar(41), false)
})

test('internet caiu no download: erro, mas dá para tentar de novo', async () => {
  const { up, handoffs } = await macUpdater('mac-rede', { fetch: fakeFetch(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })) })
  const st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA })
  assert.equal(st.fase, 'erro')
  assert.match(st.erro, /internet/)
  assert.equal(up.podeInstalar(41), true)
  assert.equal(handoffs.length, 0)
})

test('pasta sem permissão, app aberto do disco de instalação ou em quarentena de caminho: sem Atualizar', async () => {
  const semPermissao = await macUpdater('mac-perm', { canWrite: p => !p.endsWith('Applications') })
  assert.equal(semPermissao.up.disponivel, false)
  assert.match(semPermissao.up.motivo, /permissão/)
  assert.throws(() => semPermissao.up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA }), err => err.status === 409)

  const dmg = new Updater({ platform: 'darwin', appExe: '/Volumes/SOBEDESCE/SOBEDESCE.app/Contents/MacOS/SOBEDESCE', appPid: 1, handoff() {}, canWrite: () => true })
  assert.match(dmg.motivo, /disco de instalação/)
  const translocado = new Updater({ platform: 'darwin', appExe: '/private/var/folders/x/AppTranslocation/ABC/d/SOBEDESCE.app/Contents/MacOS/SOBEDESCE', appPid: 1, handoff() {}, canWrite: () => true })
  assert.match(translocado.motivo, /Aplicativos/)
  const linux = new Updater({ platform: 'linux', appExe: '/opt/sobedesce/sobedesce', appPid: 1, handoff() {} })
  assert.equal(linux.disponivel, false)
  const semHandoff = new Updater({ platform: 'darwin', appExe: '/Applications/SOBEDESCE.app/Contents/MacOS/SOBEDESCE', appPid: 1, canWrite: () => true })
  assert.equal(semHandoff.disponivel, false)
})

test('hdiutil falhou: erro definitivo, nada fica para trás', async () => {
  const { up, handoffs, apps, tmpRoot } = await macUpdater('mac-hdiutil', {
    run: async cmd => {
      if (cmd === 'hdiutil') throw Object.assign(new Error('hdiutil: attach failed'), { stderr: 'image not recognized' })
      return ''
    },
  })
  const st = await up.install({ build: 41, url: `${SITE}/baixar/mac`, sha256: SHA })
  assert.equal(st.fase, 'erro')
  assert.equal(st.bloqueado, 41)
  assert.equal(handoffs.length, 0)
  assert.deepEqual(await fs.readdir(tmpRoot), [])
  assert.deepEqual((await fs.readdir(apps)).sort(), ['SOBEDESCE.app'])
})

test('a troca anterior falhou (marca do script): mostra o motivo e fica o Baixar para aquele build', async () => {
  const { stateDir } = await macUpdater('mac-marca')
  await fs.writeFile(path.join(stateDir, 'atualizacao-falhou.json'), '\uFEFF' + JSON.stringify({ build: 41, motivo: 'O macOS não deixou trocar o app.' }))
  const up = new Updater({ platform: 'darwin', appExe: path.join(dir, 'mac-marca', 'Applications', 'SOBEDESCE.app', 'Contents', 'MacOS', 'SOBEDESCE'), appPid: 1, stateDir, handoff() {}, canWrite: () => true })
  assert.equal(up.status().fase, 'erro')
  assert.match(up.status().erro, /não deixou trocar/)
  assert.equal(up.podeInstalar(41), false)
  assert.equal(up.podeInstalar(42), true)
  assert.equal(fss.existsSync(path.join(stateDir, 'atualizacao-falhou.json')), false, 'a marca é lida uma vez só')
})

test('Windows: baixa, confere e entrega o script que roda o instalador em silêncio', async () => {
  const root = path.join(dir, 'win')
  const tmpRoot = path.join(root, 'tmp')
  await fs.mkdir(tmpRoot, { recursive: true })
  const handoffs = []
  const exe = 'C:\\Users\\Zé\\AppData\\Local\\Programs\\sobedesce\\SOBEDESCE.exe'
  const up = new Updater({ platform: 'win32', appExe: exe, appPid: 777, stateDir: root, tmpRoot, handoff: j => handoffs.push(j), canWrite: () => true, progressMs: 0, download: (url, file, p) => downloadTo(url, file, { fetch: fakeFetch(), onProgress: p }) })
  const st = await up.install({ build: 41, url: `${SITE}/baixar/windows`, sha256: SHA })
  assert.equal(st.fase, 'reiniciando')
  const script = handoffs[0].script
  assert.equal(path.basename(script), 'trocar.ps1')
  const texto = await fs.readFile(script, 'utf8')
  assert.ok(texto.startsWith('\uFEFF'), 'UTF-8 com BOM para o PowerShell 5')
  assert.match(texto, /\$appPid = 777/)
  assert.match(texto, /'\/S', '--updated', '--force-run'/)
  assert.match(texto, /WaitForExit/)
  assert.ok(texto.includes(psQuote(exe)))
  assert.ok(fss.existsSync(path.join(path.dirname(script), 'SOBEDESCE-setup.exe')))
})

test('script do Mac de verdade: espera o app fechar, troca e abre; se não der, o antigo volta e fica a marca', async () => {
  const root = path.join(dir, 'troca')
  const shims = path.join(root, 'bin')
  await fs.mkdir(shims, { recursive: true })
  const opened = path.join(root, 'abriu.txt')
  await fs.writeFile(path.join(shims, 'open'), `#!/bin/sh\nprintf '%s' "$1" > ${shQuote(opened)}\n`, { mode: 0o755 })
  await fs.writeFile(path.join(shims, 'xattr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  async function cenario(nome, { comNovo = true } = {}) {
    const base = path.join(root, nome)
    const app = path.join(base, "Apps d'Zé", 'SOBEDESCE.app')
    const novo = path.join(base, "Apps d'Zé", '.SOBEDESCE-atualizacao.app')
    const velho = path.join(base, "Apps d'Zé", '.SOBEDESCE-antigo.app')
    const tmp = path.join(base, 'tmp')
    const marca = path.join(base, 'atualizacao-falhou.json')
    await fs.mkdir(app, { recursive: true })
    await fs.writeFile(path.join(app, 'v'), 'antiga')
    if (comNovo) {
      await fs.mkdir(novo, { recursive: true })
      await fs.writeFile(path.join(novo, 'v'), 'nova')
    }
    await fs.mkdir(tmp, { recursive: true })
    // O "app aberto": um processo que fecha logo; o script espera ele sair.
    const fake = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
    const script = path.join(tmp, 'trocar.sh')
    await fs.writeFile(script, macScript({ pid: fake.pid, app, novo, velho, marca, tmp, build: 41 }))
    // spawn (não spawnSync): o laço de eventos precisa ficar livre para recolher o "app" que fechou.
    const t0 = Date.now()
    const sh = spawn('/bin/sh', [script], { env: { ...process.env, PATH: `${shims}:${process.env.PATH}` }, stdio: 'ignore' })
    const code = await new Promise(r => sh.on('exit', r))
    assert.ok(Date.now() - t0 >= 200, 'só trocou depois do app fechar')
    return { code, app, novo, velho, tmp, marca }
  }

  await fs.rm(opened, { force: true })
  const ok = await cenario('ok')
  assert.equal(await fs.readFile(path.join(ok.app, 'v'), 'utf8'), 'nova')
  assert.equal(fss.existsSync(ok.novo), false)
  assert.equal(fss.existsSync(ok.velho), false)
  assert.equal(fss.existsSync(ok.tmp), false, 'a pasta temporária foi apagada')
  assert.equal(fss.existsSync(ok.marca), false)
  assert.equal(await fs.readFile(opened, 'utf8'), ok.app)

  await fs.rm(opened, { force: true })
  const falhou = await cenario('falhou', { comNovo: false })
  assert.equal(await fs.readFile(path.join(falhou.app, 'v'), 'utf8'), 'antiga', 'o app antigo voltou')
  assert.equal(fss.existsSync(falhou.velho), false)
  const marca = JSON.parse(await fs.readFile(falhou.marca, 'utf8'))
  assert.equal(marca.build, 41)
  assert.match(marca.motivo, /macOS/)
  assert.equal(await fs.readFile(opened, 'utf8'), falhou.app, 'abre o app antigo de novo')
})

test('script do Windows: caminhos com aspas e acentos ficam entre aspas simples', () => {
  const texto = winScript({ pid: 1, setup: "C:\\T\\it's\\setup.exe", exe: 'C:\\Zé\\SOBEDESCE.exe', marca: 'C:\\m.json', tmp: 'C:\\T', build: 9 })
  assert.ok(texto.includes(`$setup = 'C:\\T\\it''s\\setup.exe'`))
  assert.ok(texto.includes(`'{"build":9,`))
})

// ─────────── VersionChecker + rota ───────────

async function freshSettings(name) {
  const s = new Settings(path.join(dir, `${name}.json`))
  await s.load()
  return s
}

test('VersionChecker: podeAtualizar só com Updater pronto e SHA-256 da plataforma; update() começa e o progresso vira status', async () => {
  const s = await freshSettings('vc')
  const { up, handoffs } = await macUpdater('vc')
  let answer = remote(41, { sha256Mac: null })
  const v = new VersionChecker({ settings: s, fetchJSON: async () => answer, buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up, autoBaixar: false })
  let st = await v.check()
  assert.equal(st.nova, true)
  assert.equal(st.podeAtualizar, false, 'sem o SHA-256 do Mac, só Baixar')
  assert.equal(st.atualizacao, null)

  answer = remote(41)
  st = await v.check()
  assert.equal(st.podeAtualizar, true)
  assert.equal(st.ultima.sha256.mac, SHA)

  // saiu o 42 depois da última conferida: o update() pergunta de novo antes de baixar
  answer = remote(42)
  const fases = []
  v.on('status', x => x.atualizacao && fases.push(x.atualizacao.fase))
  st = await v.update()
  assert.equal(st.ultima.build, 42, 'conferiu de novo antes de baixar')
  assert.equal(st.atualizacao.build, 42)
  assert.equal(st.atualizacao.fase, 'baixando')
  await waitFor(() => handoffs.length === 1)
  assert.ok(fases.includes('conferindo') && fases.at(-1) === 'reiniciando')
  v.stop()

  const semUpdater = new VersionChecker({ settings: s, fetchJSON: async () => remote(41), buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin' })
  st = await semUpdater.check()
  assert.equal(st.podeAtualizar, false)
  await assert.rejects(semUpdater.update(), err => err.status === 409)
  const igual = new VersionChecker({ settings: s, fetchJSON: async () => remote(40), buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up })
  await igual.check()
  await assert.rejects(igual.update(), err => err.status === 409)
})

test('versão nova: baixa sozinho em segundo plano (o instalador daquele build) e espera o Atualizar agora', async () => {
  const s = await freshSettings('auto')
  const fetch = fakeFetch()
  const { up, handoffs } = await macUpdater('auto', { fetch })
  const v = new VersionChecker({ settings: s, fetchJSON: async () => remote(41), buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up })
  await v.check()
  await waitFor(() => up.status().fase === 'pronto')
  assert.equal(fetch.calls[0].url, `${SITE}/baixar/mac?build=41`, 'pede o instalador do build conferido')
  assert.equal(handoffs.length, 0, 'não fecha o app sozinho')
  let st = v.status()
  assert.equal(st.atualizacao.fase, 'pronto')
  assert.equal(st.atualizacao.aplicar, false)
  // conferir de novo não baixa outra vez
  await v.check()
  assert.equal(fetch.calls.length, 1)
  st = await v.update()
  await waitFor(() => handoffs.length === 1)
  assert.equal(up.status().fase, 'reiniciando')
  assert.equal(fetch.calls.length, 1, 'Atualizar agora usa o que já baixou')
  v.stop()
})

test('Atualizar agora no meio do download: troca assim que terminar', async () => {
  const s = await freshSettings('auto-meio')
  let solta
  const segura = new Promise(r => (solta = r))
  const base = fakeFetch()
  const fetch = async (url, opts) => {
    await segura
    return base(url, opts)
  }
  const { up, handoffs } = await macUpdater('auto-meio', { fetch })
  const v = new VersionChecker({ settings: s, fetchJSON: async () => remote(41), buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up })
  await v.check()
  assert.equal(up.status().fase, 'baixando')
  const st = await v.update()
  assert.equal(st.atualizacao.aplicar, true)
  solta()
  await waitFor(() => handoffs.length === 1)
  v.stop()
})

test('download automático falhou (rede): tenta de novo sozinho; build dispensado não baixa', async () => {
  const s = await freshSettings('auto-rede')
  let falhas = 1
  const ok = fakeFetch()
  const fetch = async (url, opts) => {
    if (falhas-- > 0) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
    return ok(url, opts)
  }
  const { up } = await macUpdater('auto-rede', { fetch })
  const v = new VersionChecker({ settings: s, fetchJSON: async () => remote(41), buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up, retryBaseMs: 20 })
  await v.check()
  await waitFor(() => up.status().fase === 'pronto')
  v.stop()

  const s2 = await freshSettings('auto-depois')
  await s2.update({ versaoDispensada: 41 })
  const f2 = fakeFetch()
  const { up: up2 } = await macUpdater('auto-depois', { fetch: f2 })
  const v2 = new VersionChecker({ settings: s2, fetchJSON: async () => remote(41), buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up2 })
  await v2.check()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(f2.calls.length, 0, '"Depois" vale também para o download automático')
  v2.stop()
})

test('saiu um build mais novo com o anterior já pronto: troca pelo novo', async () => {
  const s = await freshSettings('auto-novo')
  const fetch = fakeFetch()
  const { up, apps } = await macUpdater('auto-novo', { fetch })
  let answer = remote(41)
  const v = new VersionChecker({ settings: s, fetchJSON: async () => answer, buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', updater: up })
  await v.check()
  await waitFor(() => up.status().fase === 'pronto' && up.status().build === 41)
  answer = remote(42)
  await v.check()
  await waitFor(() => up.status().fase === 'pronto' && up.status().build === 42)
  assert.equal(fetch.calls.at(-1).url, `${SITE}/baixar/mac?build=42`)
  assert.ok(fss.existsSync(path.join(apps, '.SOBEDESCE-atualizacao.app')))
  v.stop()
})

function call(app, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const headers = { host: `127.0.0.1:${app.port}` }
    if (method !== 'GET') headers['content-type'] = 'application/json'
    if (data) headers['content-length'] = Buffer.byteLength(data)
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: p, headers, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

test('rota /api/versao/atualizar: com transferências andando pede confirmação (409); com pausar: true segue', async () => {
  const home = await makeTmpDir('sobedesce-updater-app-')
  const { calls, handoffs, apps, tmpRoot } = await macUpdater('rota')
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'hdiutil' && args[0] === 'attach') await fs.mkdir(path.join(args[args.indexOf('-mountpoint') + 1], 'SOBEDESCE.app'), { recursive: true })
    if (cmd === 'ditto') await fs.cp(args[0], args[1], { recursive: true })
    return ''
  }
  let answer = remote(40) // o site ainda não tem build mais novo
  const app = await startApp({
    home,
    port: 0,
    open: false,
    quiet: true,
    managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} } },
    serverOptions: { log: () => {}, media: false },
    versionOptions: { buildInfo: { build: 40 }, baseUrl: SITE, platform: 'darwin', fetchJSON: async () => answer, firstDelayMs: 60_000 },
    updaterOptions: {
      platform: 'darwin',
      appExe: path.join(apps, 'SOBEDESCE.app', 'Contents', 'MacOS', 'SOBEDESCE'),
      appPid: 4242,
      tmpRoot,
      handoff: job => handoffs.push(job),
      download: (url, file, p) => downloadTo(url, file, { fetch: fakeFetch(), onProgress: p }),
      run,
      canWrite: () => true,
      progressMs: 0,
    },
  })
  try {
    let r = await call(app, 'POST', '/api/versao/atualizar', {})
    assert.equal(r.status, 409, 'sem versão nova (o update() pergunta ao site antes)')
    answer = remote(41)

    r = await call(app, 'POST', '/api/versao/verificar')
    assert.equal(r.json.versao.podeAtualizar, true)

    app.manager.activeCount = () => 2
    r = await call(app, 'POST', '/api/versao/atualizar', {})
    assert.equal(r.status, 409)
    assert.match(r.json.error, /transferências em andamento/)
    assert.equal(handoffs.length, 0)

    r = await call(app, 'POST', '/api/versao/atualizar', { pausar: 'sim' })
    assert.equal(r.status, 400)

    r = await call(app, 'POST', '/api/versao/atualizar', { pausar: true })
    assert.equal(r.status, 200)
    assert.ok(['baixando', 'conferindo', 'preparando', 'pronto', 'reiniciando'].includes(r.json.versao.atualizacao.fase))
    await waitFor(() => handoffs.length === 1)
    r = await call(app, 'GET', '/api/versao')
    assert.equal(r.json.versao.atualizacao.fase, 'reiniciando')

    r = await call(app, 'GET', '/api/versao/atualizar')
    assert.equal(r.status, 405)
  } finally {
    await app.shutdown()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('rota sem Updater (npm start, Linux, build de desenvolvimento): podeAtualizar falso e 409', async () => {
  const home = await makeTmpDir('sobedesce-updater-sem-')
  const app = await startApp({
    home,
    port: 0,
    open: false,
    quiet: true,
    managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} } },
    serverOptions: { log: () => {}, media: false },
    versionOptions: { buildInfo: { build: 40 }, baseUrl: SITE, platform: 'win32', fetchJSON: async () => remote(41), firstDelayMs: 60_000 },
  })
  try {
    let r = await call(app, 'POST', '/api/versao/verificar')
    assert.equal(r.json.versao.nova, true)
    assert.equal(r.json.versao.podeAtualizar, false)
    r = await call(app, 'POST', '/api/versao/atualizar', {})
    assert.equal(r.status, 409)
    assert.match(r.json.error, /Baixar/)
  } finally {
    await app.shutdown()
    await fs.rm(home, { recursive: true, force: true })
  }
})
