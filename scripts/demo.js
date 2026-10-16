#!/usr/bin/env node
// Demo (npm run demo): sobe o SOBEDESCE ligado a um Google Drive falso, com um projeto de audiovisual de exemplo.
// Não precisa de chave do Google nem de internet. Tudo fica em .sobedesce-dev/demo (apagado a cada início);
// SOBEDESCE_DEMO_HOME troca a pasta (útil para rodar dois demos ao mesmo tempo, ou em testes ponta a ponta).
//
// O Drive falso limita cada conexão a ~6 MB/s (com um pouco de latência): assim dá para ver o download segmentado
// enchendo a banda com várias conexões, pausar no meio, retomar, e o upload em vários arquivos ao mesmo tempo.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'undici'
import { startMockDrive, writeVirtualFile } from '../test/mock-drive.js'
import { AuthManager } from '../src/google/oauth.js'
import { Settings, dataPaths } from '../src/config.js'
import { startApp } from '../src/index.js'
import { closeHttp, dispatcherFor } from '../src/net/http.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_HOME = path.join(ROOT, '.sobedesce-dev', 'demo')
const HOME = process.env.SOBEDESCE_DEMO_HOME ? path.resolve(process.env.SOBEDESCE_DEMO_HOME) : DEFAULT_HOME
// A pasta do demo é apagada a cada início: só apagamos uma que o próprio demo criou (marca) ou que está vazia.
const MARKER = '.sobedesce-demo'
const DOWNLOADS = path.join(HOME, 'Downloads')
const LOCAL = path.join(HOME, 'Projeto Local')
const MB = 1_000_000
const EXIT_DEADLINE_MS = 9500

// ─────────── o Drive de exemplo ───────────

let seedSeq = 100
const day = d => `2026-06-${String(d).padStart(2, '0')}T${String(8 + (seedSeq % 10)).padStart(2, '0')}:${String((seedSeq * 7) % 60).padStart(2, '0')}:00.000Z`

/** Monta a árvore; devolve os itens que a pasta local de exemplo espelha. */
function buildDrive(mock) {
  const files = []
  const file = (name, parent, sizeMb, d = 12) => {
    const seed = seedSeq++
    const item = mock.addFile(name, parent, { size: Math.round(sizeMb * MB), seed, modifiedTime: day(d) })
    files.push(item)
    return item
  }
  const folder = (name, parent = 'root') => mock.addFolder(name, parent, { modifiedTime: day(12) })

  const doc = folder('Documentário Mar Aberto')
  const brutos = folder('Brutos', doc.id)
  const d1 = folder('Dia 01', brutos.id)
  file('A001_C001_0612XY.mov', d1.id, 1200, 12)
  file('A001_C002_0612QM.mov', d1.id, 980, 12)
  file('A001_C003_0612RT.mov', d1.id, 1450, 12)
  file('A001_C004_0612PL.mov', d1.id, 640, 12)
  const d2 = folder('Dia 02', brutos.id)
  file('B002_C011_0613B5.braw', d2.id, 1300, 13)
  file('B002_C012_0613K2.braw', d2.id, 870, 13)
  file('B002_C013_0613ZZ.braw', d2.id, 520, 13)
  const d3 = folder('Dia 03', brutos.id)
  file('C003_C021_0614AA.mov', d3.id, 760, 14)
  file('C003_C022_0614AB.mov', d3.id, 1100, 14)
  file('C003_C023_0614AC.mov', d3.id, 420, 14)

  const audio = folder('Áudio', doc.id)
  file('Boom_T01.wav', audio.id, 180, 12)
  file('Boom_T02.wav', audio.id, 210, 13)
  file('Lapela_Entrevista.wav', audio.id, 150, 13)
  file('Musica_Temp.mp3', audio.id, 62, 15)
  const amb = folder('Ambientes', audio.id)
  file('Gaivotas.wav', amb.id, 95, 12)
  file('Ondas_Noite.wav', amb.id, 120, 13)
  const porto = file('Porto_Manha.wav', amb.id, 58, 14)

  const fotos = folder('Fotos', doc.id)
  const img17 = file('IMG_0417.CR3', fotos.id, 51, 12)
  const img18 = file('IMG_0418.CR3', fotos.id, 53, 12)
  file('IMG_0421.CR3', fotos.id, 56, 13)

  const projeto = folder('Projeto', doc.id)
  const prproj = file('Projeto.prproj', projeto.id, 52, 16)
  const roteiro = file('Roteiro_v4.pdf', projeto.id, 50, 16)
  mock.addGoogleDoc('Roteiro de gravação', projeto.id, 'document', { size: 180_000, modifiedTime: day(10) })

  const entrega = folder('Entrega', doc.id)
  const master = file('Master_ProRes.mov', entrega.id, 1500, 20)
  file('Master_H264.mp4', entrega.id, 420, 20)
  file('Trailer_30s.mov', entrega.id, 310, 21)
  file('Teaser_Instagram.mp4', entrega.id, 85, 21)

  const proxy = folder('Proxy')
  file('A001_C001_Proxy.mp4', proxy.id, 120, 12)
  file('A001_C002_Proxy.mp4', proxy.id, 95, 12)
  file('B002_C011_Proxy.mp4', proxy.id, 110, 13)

  const bastidores = folder('Fotos de Bastidores')
  file('Bastidores_01.jpg', bastidores.id, 52, 12)
  file('Bastidores_02.jpg', bastidores.id, 54, 13)
  file('Equipe_Final.jpg', bastidores.id, 61, 14)

  mock.addShortcut('Master_ProRes (atalho).mov', 'root', master.id)

  // Drive compartilhado da produtora.
  const xyz = mock.addSharedDrive('Produtora XYZ')
  const clientes = folder('Clientes', xyz.id)
  const oceano = folder('Oceano Azul', clientes.id)
  file('Briefing_Oceano_Azul.pdf', oceano.id, 55, 5)
  file('Moodboard.psd', oceano.id, 240, 6)
  const trilhas = folder('Biblioteca de Trilhas', xyz.id)
  file('Trilha_Tema.wav', trilhas.id, 90, 3)
  file('Trilha_Tensao.wav', trilhas.id, 110, 3)
  file('Trilha_Final.wav', trilhas.id, 75, 4)
  const modelos = folder('Modelos', xyz.id)
  file('Abertura_4K.mov', modelos.id, 690, 2)
  file('Lower_Thirds.mov', modelos.id, 130, 2)
  mock.addGoogleDoc('Orçamento 2026', xyz.id, 'spreadsheet', { size: 64_000, modifiedTime: day(8) })

  return { files, mirror: { prproj, roteiro, img17, img18, porto } }
}

/** "Projeto Local": parte igual ao Drive, um arquivo diferente e alguns que ainda não subiram. */
async function buildLocal(mirror) {
  const same = [
    ['Projeto/Projeto.prproj', mirror.prproj],
    ['Fotos/IMG_0417.CR3', mirror.img17],
    ['Fotos/IMG_0418.CR3', mirror.img18],
    ['Áudio/Ambientes/Porto_Manha.wav', mirror.porto],
  ]
  for (const [rel, item] of same) await writeLocal(rel, item.size, item.seed)
  // Diferente: outra versão do roteiro (tamanho diferente).
  await writeLocal('Projeto/Roteiro_v4.pdf', mirror.roteiro.size - 1_234_567, 9001)
  // Só no computador (falta subir).
  await writeLocal('Áudio/Boom_T03.wav', 12 * MB, 9002)
  await writeLocal('Brutos/Dia 04/D004_C031_0615FF.mov', 30 * MB, 9003)
  await fs.writeFile(path.join(LOCAL, 'Notas de campo.txt'), 'Dia 04: chuva de manhã, gravamos o porto à tarde.\nTrocar a lapela do entrevistado (ruído no T02).\n')
}

async function writeLocal(rel, size, seed) {
  const p = path.join(LOCAL, ...rel.split('/'))
  await fs.mkdir(path.dirname(p), { recursive: true })
  await writeVirtualFile(p, { size, seed })
}

// ─────────── login pelo fluxo de verdade (AuthManager + tela de consentimento do mock) ───────────

async function login(paths, mock) {
  const auth = new AuthManager({ paths })
  await auth.init()
  await auth.setClientCredentials(mock.client)
  const { url } = auth.beginLogin('http://127.0.0.1:4317/oauth/callback')
  const res = await request(url, { method: 'GET', dispatcher: dispatcherFor(url) })
  await res.body.dump()
  const location = res.headers.location
  if (res.statusCode !== 302 || !location) throw new Error(`a tela de consentimento falsa não redirecionou (HTTP ${res.statusCode})`)
  const back = new URL(location)
  return auth.completeLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), error: back.searchParams.get('error') })
}

// ─────────── início ───────────

async function demoAlreadyRunning() {
  try {
    const info = JSON.parse(await fs.readFile(path.join(HOME, 'engine.lock'), 'utf8'))
    process.kill(Number(info.pid), 0)
    return info.url || true
  } catch (err) {
    return err?.code === 'EPERM' ? true : null
  }
}

async function wipeDemoHome() {
  let names
  try {
    names = await fs.readdir(HOME)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  const ours = HOME === DEFAULT_HOME || names.includes(MARKER) || names.length === 0
  if (!ours) throw new Error(`${HOME} não é uma pasta do demo (não tem ${MARKER}) e não está vazia; não vou apagar`)
  await fs.rm(HOME, { recursive: true, force: true })
}

async function main() {
  const running = await demoAlreadyRunning()
  if (running) {
    console.log(`\n  O demo já está aberto${typeof running === 'string' ? ` em ${running}` : ''}. Feche o outro antes (Ctrl+C).\n`)
    process.exitCode = 1
    return
  }
  console.log('\n  Preparando o demo (Drive de exemplo, conta conectada e uma pasta local para comparar)…')
  await wipeDemoHome()
  await fs.mkdir(DOWNLOADS, { recursive: true })
  await fs.writeFile(path.join(HOME, MARKER), 'Pasta do demo do SOBEDESCE: apagada a cada início.\n')
  await fs.mkdir(LOCAL, { recursive: true })

  // Sem foto de perfil: a do usuário falso apontaria para o Google, e o demo promete que nada sai do computador.
  const mock = await startMockDrive({ perConnectionBps: 6 * MB, latencyMs: 20, seed: 2026, user: { photoLink: null } })
  mock.applyEnv()
  let app = null
  let stopping = false
  const stop = async code => {
    if (stopping) process.exit(code)
    stopping = true
    console.log('\n  Pausando as transferências e fechando o Drive de exemplo…')
    const deadline = setTimeout(() => process.exit(code), EXIT_DEADLINE_MS)
    deadline.unref()
    await app?.shutdown().catch(() => {})
    await mock.close().catch(() => {})
    await closeHttp().catch(() => {})
    console.log('  Pronto. Até a próxima!\n')
    process.exit(code)
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))

  try {
    const { files, mirror } = buildDrive(mock)
    // O Drive falso calcula o MD5 de cada arquivo na primeira listagem; adiantando aqui, as pastas abrem na hora.
    ;(async () => {
      for (const f of files) await mock.contentMd5(f.id).catch(() => {})
    })()

    const paths = dataPaths(HOME)
    const settings = new Settings(paths.settings)
    await settings.load()
    await settings.update({ downloadDir: DOWNLOADS })
    const account = await login(paths, mock)
    await buildLocal(mirror)

    const port = Number(process.env.SOBEDESCE_PORT) || 4317
    app = await startApp({ home: HOME, port, open: process.env.SOBEDESCE_NO_OPEN !== '1' })
    const total = files.reduce((a, f) => a + f.size, 0)
    console.log('  Modo demo: nada sai do seu computador. O "Google Drive" aqui é de mentira.')
    console.log(`  Conta conectada:      ${account.email}`)
    console.log(`  Drive de exemplo:     ${files.length} arquivos (${(total / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB), um drive compartilhado "Produtora XYZ"`)
    console.log(`  Downloads vão para:   ${DOWNLOADS}`)
    console.log(`  Para Comparar, use:   ${LOCAL}  ×  "Documentário Mar Aberto"`)
    console.log('')
  } catch (err) {
    console.error(`\n  Não deu para iniciar o demo: ${err.message}\n`)
    await stop(1)
  }
}

main()
