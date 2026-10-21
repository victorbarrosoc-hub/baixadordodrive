// Teste de fumaça do app empacotado (`SOBEDESCE --smoke`, rodado pelo CI no Mac e no Windows depois do build).
// O maior risco de mexer em asar, fusíveis e cofre é o app instalado não abrir: aqui o motor de verdade sobe dentro do
// Electron e confere o que mais quebra (código dentro do app.asar, worker do MD5, cópia entre discos, interface servida, ffmpeg, yt-dlp,
// QuickJS, o decodificador de Blackmagic RAW e o cofre do sistema). Sem Electron também roda (test/protecao.test.js), com os binários como "aviso".
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ffmpegCandidates, primeiro, quickjsCandidates, ytdlpCandidates } from '../src/referencias/binarios.js'
import { MOBILE_DIR } from '../src/mobile/receiver.js'
import { helperCandidates } from '../src/media/raw-thumb.js'
import { carregarOrt } from '../src/cenas/modelo.js'
import { DiscosService } from '../src/discos/servico.js'

// ONNX mínimo (opset 13): uma soma, y = x + x. Gerado com onnx.helper; só para provar que o runtime carrega.
const MODELO_DOBRO = 'CAgSCXNvYmVkZXNjZTo5Cg4KAXgKAXgSAXkiA0FkZBIFZG9icm9aDwoBeBIKCggIARIECgIIAmIPCgF5EgoKCAgBEgQKAggCQgQKABAN'

function rodar(cmd, args, timeoutMs = 60_000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, saida: `${stdout || ''}${stderr || ''}`, erro: err?.message || null })
    })
  })
}

async function obter(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  const corpo = await res.text()
  return { status: res.status, corpo }
}

/**
 * Roda as verificações. `exigirBinarios`: no app empacotado do Mac/Windows, ffmpeg, yt-dlp e QuickJS têm que vir no app
 * (falha); fora disso, faltar é só aviso. `exigirCofre`: falha se o cofre não cifrar (Windows); no Mac do CI o Keychain
 * pode estar travado e no Linux pode não haver keyring, então lá é aviso.
 * @returns {Promise<Array<{ nome: string, ok: boolean, aviso?: boolean, detalhe: string }>>}
 */
export async function verificar({ app, guarda = null, exigirBinarios = false, exigirCofre = false, env = process.env, platform = process.platform, arch = process.arch, resourcesPath = process.resourcesPath } = {}) {
  const out = []
  const passo = async (nome, fn) => {
    try {
      const r = await fn()
      out.push({ nome, ok: r.ok !== false, aviso: Boolean(r.aviso), detalhe: r.detalhe || '' })
    } catch (err) {
      out.push({ nome, ok: false, detalhe: err?.message || String(err) })
    }
  }
  const falta = (o, detalhe) => (o ? { ok: false, detalhe } : { ok: true, aviso: true, detalhe })
  const busca = { env, platform, arch, resourcesPath }

  await passo('motor', async () => {
    const r = await obter(`${app.url}/api/state`)
    const data = JSON.parse(r.corpo)
    if (r.status !== 200 || data?.ok !== true) return { ok: false, detalhe: `GET /api/state → ${r.status}` }
    return { detalhe: `${data.app?.name} ${data.app?.version || ''} em ${app.url}`.trim() }
  })

  await passo('interface', async () => {
    const ruins = []
    // /celular/*: a janela oculta do celular pelo Wi-Fi (WebRTC) carrega daqui.
    for (const p of ['/', '/app.js', '/styles.css', '/components/settings.js', '/celular/p2p.html', '/celular/p2p.js', '/celular/p2p-canal.js']) {
      const r = await obter(`${app.url}${p}`)
      if (r.status !== 200 || !r.corpo.length) ruins.push(`${p} → ${r.status}`)
    }
    return ruins.length ? { ok: false, detalhe: ruins.join(', ') } : { detalhe: 'página, scripts e estilos servidos de dentro do app' }
  })

  await passo('app do celular', async () => {
    const html = await fs.readFile(path.join(MOBILE_DIR, 'index.html'), 'utf8')
    return html.includes('<') ? { detalhe: 'casca lida' } : { ok: false, detalhe: 'index.html vazio' }
  })

  await passo('md5 (worker)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-smoke-'))
    try {
      const file = path.join(dir, 'a.bin')
      const dados = crypto.randomBytes(256 * 1024)
      await fs.writeFile(file, dados)
      const esperado = crypto.createHash('md5').update(dados).digest('hex')
      const md5 = await app.hasher.hash(file)
      return md5 === esperado ? { detalhe: 'worker_threads ok' } : { ok: false, detalhe: `md5 ${md5} ≠ ${esperado}` }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await passo('copiar entre discos (worker + xxHash64)', async () => {
    // A cópia roda num worker que carrega o xxhash-wasm de dentro do asar: é o que mais pode quebrar empacotado.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-smoke-discos-'))
    const svc = new DiscosService({ keepAwake: { setActive() {} } })
    try {
      const dados = crypto.randomBytes(3 * 1024 * 1024 + 7)
      await fs.mkdir(path.join(dir, 'CARD'))
      await fs.mkdir(path.join(dir, 'SSD'))
      await fs.writeFile(path.join(dir, 'CARD', 'C0001.MP4'), dados)
      await svc.planejar({ origem: path.join(dir, 'CARD'), destinos: [path.join(dir, 'SSD')] })
      await svc.iniciar({ conferir: true, relatorio: true })
      for (let i = 0; i < 600 && svc.fase === 'copiando'; i++) await new Promise((ok) => setTimeout(ok, 50))
      const v = svc.view()
      const copia = await fs.readFile(path.join(dir, 'SSD', 'CARD', 'C0001.MP4')).catch(() => null)
      const rel = v.resultado?.relatorios?.[0] ? await fs.readFile(v.resultado.relatorios[0], 'utf8') : ''
      if (v.fase !== 'feito' || !copia?.equals(dados)) return { ok: false, detalhe: `fase ${v.fase}: ${v.erro || v.resultado?.falhas?.[0]?.erro || 'cópia diferente'}` }
      return /^[0-9a-f]{16} {2}C0001\.MP4$/m.test(rel) ? { detalhe: 'cópia conferida, relatório .xxh64' } : { ok: false, detalhe: `relatório inesperado: ${rel.slice(0, 80)}` }
    } finally {
      await svc.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await passo('ffmpeg', async () => {
    const c = primeiro(ffmpegCandidates(busca))
    // O Windows ARM sai sem ffmpeg (não há um build fixo para ele; ver scripts/ffmpeg-baixar.mjs).
    const exigir = exigirBinarios && !(platform === 'win32' && arch === 'arm64')
    if (!c || c.origem !== 'app') return falta(exigir, c ? `só o do sistema (${c.path})` : 'não veio no app')
    const r = await rodar(c.path, ['-hide_banner', '-version'])
    const v = /ffmpeg version (\S+)/.exec(r.saida)
    return r.code === 0 && v ? { detalhe: `${v[1]} (${c.path})` } : { ok: false, detalhe: `não rodou: ${r.erro || r.saida.slice(0, 200)}` }
  })

  await passo('yt-dlp', async () => {
    const c = primeiro(ytdlpCandidates(busca))
    if (!c || c.origem !== 'app') return falta(exigirBinarios, c ? `só o do sistema (${c.path})` : 'não veio no app')
    const r = await rodar(c.path, ['--version'], 120_000)
    return r.code === 0 ? { detalhe: `${r.saida.trim()} (${c.path})` } : { ok: false, detalhe: `não rodou: ${r.erro || r.saida.slice(0, 200)}` }
  })

  await passo('quickjs', async () => {
    const c = primeiro(quickjsCandidates(busca))
    if (!c) return falta(exigirBinarios, 'não veio no app (o YouTube nas Referências fica sem o JavaScript dos desafios)')
    const r = await rodar(c.path, ['--help'])
    const v = /QuickJS-ng version (\S+)/.exec(r.saida)
    return v ? { detalhe: `QuickJS-ng ${v[1]} (${c.path})` } : { ok: false, detalhe: `não rodou: ${r.erro || r.saida.slice(0, 200)}` }
  })

  await passo('blackmagic raw', async () => {
    // Vem no app quando o CI tem o cadastro do SDK (scripts/raw-frame-build.mjs); sem ele, o .braw só fica sem proxy.
    const c = helperCandidates(busca).find(p => existsSync(p))
    if (!c) return { aviso: true, detalhe: 'não veio no app (o .braw fica sem proxy)' }
    const r = await rodar(c, ['--check'])
    return r.code === 0 ? { detalhe: `biblioteca da Blackmagic abriu (${c})` } : { ok: false, detalhe: `--check saiu com ${r.code}: ${r.erro || r.saida.slice(0, 300)}` }
  })

  await passo('busca por cena (onnxruntime)', async () => {
    // O motor da IA da busca por cena (src/cenas/modelo.js) carrega de dentro do app e roda um modelo de 78 bytes
    // (y = x + x). O Mac Intel não tem binário do onnxruntime: lá a busca avisa que não roda, e o teste só avisa.
    const ort = await carregarOrt()
    if (!ort) return falta(exigirBinarios && !(platform === 'darwin' && arch === 'x64'), 'o onnxruntime-node não carregou')
    const s = await ort.InferenceSession.create(Buffer.from(MODELO_DOBRO, 'base64'))
    const r = await s.run({ x: new ort.Tensor('float32', Float32Array.from([1.5, -2]), [2]) })
    await s.release?.()
    const y = Array.from(r.y.data)
    return y[0] === 3 && y[1] === -4 ? { detalhe: 'modelo de teste rodou (y = x + x)' } : { ok: false, detalhe: `saída errada: ${y}` }
  })

  await passo('cofre', async () => {
    if (!guarda) return falta(exigirCofre, 'sem guarda (fora do Electron)')
    if (!(await guarda.disponivel())) return falta(exigirCofre, 'a proteção do sistema não está disponível nesta máquina')
    const texto = `sobedesce-smoke-${crypto.randomBytes(8).toString('hex')}`
    const cifrado = await guarda.cifrar(texto)
    if (Buffer.from(cifrado).includes(Buffer.from(texto))) return { ok: false, detalhe: 'o cifrado contém o texto em claro' }
    const volta = await guarda.decifrar(cifrado)
    return volta === texto ? { detalhe: 'cifrar e decifrar ok' } : { ok: false, detalhe: 'decifrou outro conteúdo' }
  })

  return out
}

/** Texto do resultado (uma linha por verificação + "SMOKE OK" / "SMOKE FALHOU"). */
export function relatorio(checks) {
  const linhas = checks.map(c => `${c.ok ? (c.aviso ? 'AVISO' : 'ok   ') : 'FALHA'} ${c.nome}: ${c.detalhe}`)
  const ok = checks.length > 0 && checks.every(c => c.ok)
  linhas.push(ok ? 'SMOKE OK' : 'SMOKE FALHOU')
  return { ok, texto: linhas.join('\n') }
}
