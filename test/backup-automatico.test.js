// Backup Automático (docs/BACKUP-AUTOMATICO.md): discos montados por sistema, a câmera pelo XML da Sony, o
// reconhecimento do dono (volume, serial, um toque), as pastas Diária/Cenas/Dono/Cartão NN, a segunda leva só com o que
// é novo, destino ausente que espera, ignorar disco e a persistência. Cópia de verdade em pastas temporárias.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lerGetVolume, lerPlistDiskutil, listarVolumes, serialDoVol } from '../src/backup/volumes.js'
import { lerCamera, lerXmlSony, nomeCurto } from '../src/backup/camera.js'
import { ANTERIORES, BackupService } from '../src/backup/servico.js'

const tmp = (p = 'sobedesce-bkp-') => fs.mkdtempSync(path.join(os.tmpdir(), p))
const sem = { setActive() {} }

function escrever(raiz, rel, conteudo, mtime) {
  const f = path.join(raiz, ...rel.split('/'))
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, conteudo)
  if (mtime) fs.utimesSync(f, mtime, mtime)
  return f
}

const xmlSony = (modelo, serial) => `<?xml version="1.0"?><NonRealTimeMeta><Device manufacturer="Sony" modelName="${modelo}" serialNo="${serial}"/></NonRealTimeMeta>`

/** Um cartão Sony falso numa pasta temporária. */
function cartaoSony({ modelo = 'ILME-FX30', serial = '5012345', clipes = 2 } = {}) {
  const raiz = tmp('sobedesce-cartao-')
  for (let i = 1; i <= clipes; i++) {
    escrever(raiz, `PRIVATE/M4ROOT/CLIP/C000${i}.MP4`, Buffer.alloc(3000 + i, i))
    escrever(raiz, `PRIVATE/M4ROOT/CLIP/C000${i}M01.XML`, xmlSony(modelo, serial))
  }
  escrever(raiz, 'PRIVATE/M4ROOT/MEDIAPRO.XML', `<clips n="${clipes}"/>`, new Date(Date.now() - 60_000))
  return raiz
}

async function esperar(fn, ms = 15_000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('demorou demais')
    await new Promise((ok) => setTimeout(ok, 20))
  }
}

/** Serviço com o vigia desligado e uma lista de discos que o teste controla. */
function montar({ arquivo = path.join(tmp(), 'backup.json'), agora } = {}) {
  const discos = []
  const avisos = []
  const ejetados = []
  const svc = new BackupService({ arquivo, listar: async () => discos.map((d) => ({ ...d })), vigiaMs: 0, keepAwake: sem, avisar: (ev, d) => avisos.push([ev, d]), ejetar: async (c) => (ejetados.push(c), true), agora })
  const ocioso = () => esperar(() => !svc.rodando && !svc.fila.length)
  return { svc, discos, avisos, ejetados, arquivo, ocioso }
}

// ───── discos montados ─────

test('macOS: /Volumes sem a raiz (atalho), ocultos, disco interno e imagem; id pelo VolumeUUID', async () => {
  const entradas = ['Macintosh HD', '.Trashes', 'SD FX30', 'SOBEDESCE', 'Interno 2', 'SEM UUID'].map((name) => ({ name }))
  const plists = {
    '/Volumes/SD FX30': '<dict><key>VolumeUUID</key><string>AAAA-1111</string><key>VolumeName</key><string>SD FX30</string><key>Internal</key><false/><key>BusProtocol</key><string>USB</string><key>TotalSize</key><integer>128000000000</integer></dict>',
    '/Volumes/SOBEDESCE': '<dict><key>VolumeUUID</key><string>DMG</string><key>BusProtocol</key><string>Disk Image</string></dict>',
    '/Volumes/Interno 2': '<dict><key>VolumeUUID</key><string>INT</string><key>Internal</key><true/></dict>',
    '/Volumes/SEM UUID': '<dict><key>VolumeName</key><string>SEM UUID</string><key>TotalSize</key><integer>64000000000</integer></dict>',
  }
  const fsFalso = {
    readdir: async () => entradas,
    lstat: async (p) => ({ isSymbolicLink: () => p === '/Volumes/Macintosh HD' }),
  }
  const exec = async (cmd, args) => plists[args.at(-1)] ?? null
  const v = await listarVolumes({ platform: 'darwin', fs: fsFalso, exec })
  assert.deepEqual(v, [
    { caminho: '/Volumes/SD FX30', nome: 'SD FX30', id: 'uuid:AAAA-1111', capacidade: 128000000000 },
    { caminho: '/Volumes/SEM UUID', nome: 'SEM UUID', id: 'rotulo:SEM UUID:64000000000', capacidade: 64000000000 },
  ])
})

test('Windows: letras D: a Z:, sem CD/DVD; id pelo número de série do vol (em português também)', async () => {
  const existe = new Set(['D:\\', 'E:\\', 'F:\\'])
  const fsFalso = { stat: async (p) => (existe.has(p) ? {} : Promise.reject(new Error('não'))) }
  const exec = async (cmd, args) => {
    const linha = args.at(-1)
    if (cmd === 'powershell.exe') {
      if (linha.includes('-DriveLetter D')) return '{"FileSystemLabel":"EOS_DIGITAL","DriveType":"Removable","Size":64000000000}'
      if (linha.includes('-DriveLetter E')) return '{"FileSystemLabel":"DVD","DriveType":5,"Size":4700000000}'
      return '{"FileSystemLabel":"","DriveType":"Fixed","Size":2000000000000}'
    }
    if (linha === 'vol D:') return ' O volume na unidade D é EOS_DIGITAL\r\n O Número de Série do Volume é 1A2B-3C4D\r\n'
    if (linha === 'vol F:') return ' Volume in drive F has no label.\r\n Volume Serial Number is 9f8e-7d6c\r\n'
    return null
  }
  const v = await listarVolumes({ platform: 'win32', fs: fsFalso, exec })
  assert.deepEqual(v, [
    { caminho: 'D:\\', nome: 'EOS_DIGITAL', id: 'serial:1A2B-3C4D', capacidade: 64000000000 },
    { caminho: 'F:\\', nome: 'Disco F', id: 'serial:9F8E-7D6C', capacidade: 2000000000000 },
  ])
  assert.equal(serialDoVol('nada aqui'), null)
  assert.deepEqual(lerGetVolume('[{"FileSystemLabel":"X","DriveType":2,"Size":10}]'), { nome: 'X', tipo: 'Removable', capacidade: 10 })
  assert.equal(lerGetVolume('não é json'), null)
})

test('Linux: /media/<usuário> e /run/media/<usuário>, id pelo UUID do findmnt', async () => {
  const fsFalso = {
    readdir: async (p) => (p === '/media/ana' ? [{ name: 'CARD' }, { name: '.oculto' }] : p === '/run/media/ana' ? [{ name: 'SSD' }] : Promise.reject(new Error('não'))),
  }
  const exec = async (cmd, args) => (args.at(-1) === '/media/ana/CARD' ? '1234-ABCD\n' : '')
  const v = await listarVolumes({ platform: 'linux', fs: fsFalso, exec, usuario: 'ana' })
  assert.deepEqual(v.map((x) => [x.caminho, x.id.split(':')[0]]), [['/media/ana/CARD', 'uuid'], ['/run/media/ana/SSD', 'rotulo']])
  assert.equal(v[0].id, 'uuid:1234-ABCD')
  assert.equal(lerPlistDiskutil('').uuid, null)
})

// ───── câmera ─────

test('câmera: o XML da Sony dá modelo e serial; nome curto; sem XML, só o tipo pela estrutura', async () => {
  assert.deepEqual(lerXmlSony(xmlSony('ILME-FX30', '5012345')), { marca: 'Sony', modelo: 'ILME-FX30', serial: '5012345' })
  assert.equal(lerXmlSony('<x/>'), null)
  assert.equal(nomeCurto('ILME-FX30'), 'FX30')
  assert.equal(nomeCurto('ILME-FX3'), 'FX3')
  assert.equal(nomeCurto('ILCE-7SM3'), 'A7S III')
  assert.equal(nomeCurto('ILCE-7M4'), 'A7 IV')
  assert.equal(nomeCurto('ILCE-1'), 'A1')
  assert.equal(nomeCurto('ZV-E1'), 'ZV-E1')
  const c = await lerCamera(cartaoSony({ modelo: 'ILCE-7SM3', serial: '777' }))
  assert.deepEqual(c, { marca: 'Sony', modelo: 'ILCE-7SM3', serial: '777', curto: 'A7S III' })
  const gopro = tmp()
  escrever(gopro, 'DCIM/100GOPRO/GX010001.MP4', 'x')
  assert.equal((await lerCamera(gopro)).curto, 'GoPro')
  assert.equal((await lerCamera(tmp())).curto, null)
})

// ───── o serviço ─────

test('primeiro cartão: pede o dono (um toque); depois copia para Diária 01/Cenas/Dono - Câmera/Cartão 01 nos dois destinos', async () => {
  const { svc, discos, avisos, ocioso } = montar()
  await svc.init()
  const hd1 = tmp('sobedesce-hd1-')
  const hd2 = tmp('sobedesce-hd2-')
  await svc.criarProjeto({ nome: 'SERHS Evento', destinos: [hd1, hd2] })
  await svc.ligar(true)
  const card = cartaoSony()
  discos.push({ caminho: card, nome: 'SD FX30', id: 'uuid:CARD-1', capacidade: 64e9 })
  await svc.varrer()
  let v = svc.view()
  assert.equal(v.pedidos.length, 1)
  assert.equal(v.pedidos[0].camera.curto, 'FX30')
  assert.equal(v.pedidos[0].camera.serial, '5012345')
  assert.deepEqual(avisos.map(([e]) => e), ['backup-pedido'])
  assert.equal(svc.fila.length, 0, 'nada copia antes do toque')

  await svc.responder({ caminho: card, nome: 'Aladim', camera: 'FX30' })
  await ocioso()
  v = svc.view()
  assert.equal(v.ultimo.resultado, 'ok')
  assert.equal(v.ultimo.pasta, 'Diária 01 / Cenas / Aladim - FX30 / Cartão 01')
  for (const hd of [hd1, hd2]) {
    const base = path.join(hd, 'SERHS Evento', 'Diária 01', 'Cenas', 'Aladim - FX30', 'Cartão 01')
    assert.deepEqual(fs.readFileSync(path.join(base, 'PRIVATE/M4ROOT/CLIP/C0002.MP4')), fs.readFileSync(path.join(card, 'PRIVATE/M4ROOT/CLIP/C0002.MP4')))
    assert.ok(fs.readdirSync(base).some((n) => /^SOBEDESCE_copia_.*\.xxh64$/.test(n)), 'relatório de checksum no destino')
  }
  assert.equal(v.projeto.historico[0].copiados, 5)
  assert.equal(v.projeto.donos[0].rotulo, 'Aladim - FX30')
  assert.equal(v.projeto.donos[0].cartoes, 1)
  assert.equal(v.volumes[0].estado, 'ok')
  assert.ok(avisos.some(([e, d]) => e === 'backup-feito' && d.ok))
  await svc.close()
})

test('segunda leva do mesmo cartão: reconhece sozinho e copia só o novo; o índice reescrito da câmera troca e o antigo fica guardado', async () => {
  const { svc, discos, ocioso } = montar()
  await svc.init()
  const hd = tmp('sobedesce-hd-')
  await svc.criarProjeto({ nome: 'Show', destinos: [hd] })
  await svc.ligar(true)
  const card = cartaoSony({ clipes: 2 })
  const vol = { caminho: card, nome: 'SD', id: 'uuid:CARD-2', capacidade: 64e9 }
  discos.push(vol)
  await svc.varrer()
  await svc.responder({ caminho: card, nome: 'Aladim', camera: 'FX30' })
  await ocioso()
  // Cartão sai, grava mais um clipe, volta.
  discos.length = 0
  await svc.varrer()
  escrever(card, 'PRIVATE/M4ROOT/CLIP/C0003.MP4', Buffer.alloc(5000, 3))
  escrever(card, 'PRIVATE/M4ROOT/MEDIAPRO.XML', '<clips n="3" mais="atualizado"/>', new Date())
  discos.push(vol)
  await svc.varrer()
  assert.equal(svc.view().pedidos.length, 0, 'não pergunta de novo')
  await ocioso()
  const v = svc.view()
  assert.equal(v.ultimo.resultado, 'ok')
  assert.equal(v.ultimo.copiados, 2, 'só o clipe novo e o índice')
  const base = path.join(hd, 'Show', 'Diária 01', 'Cenas', 'Aladim - FX30', 'Cartão 01')
  assert.equal(fs.readFileSync(path.join(base, 'PRIVATE/M4ROOT/MEDIAPRO.XML'), 'utf8'), '<clips n="3" mais="atualizado"/>')
  const guardados = fs.readdirSync(path.join(base, ANTERIORES))
  assert.equal(guardados.length, 1)
  assert.equal(fs.readFileSync(path.join(base, ANTERIORES, guardados[0], 'PRIVATE/M4ROOT/MEDIAPRO.XML'), 'utf8'), '<clips n="2"/>')
  assert.equal(v.projeto.historico.length, 2)
  await svc.close()
})

test('cartão formatado (id novo) da mesma câmera: o serial da Sony diz o dono e vira Cartão 02; outro corpo pergunta', async () => {
  const { svc, discos, ocioso } = montar()
  await svc.init()
  const hd = tmp('sobedesce-hd-')
  await svc.criarProjeto({ nome: 'Casamento', destinos: [hd] })
  await svc.ligar(true)
  const a = cartaoSony({ serial: 'S-1' })
  discos.push({ caminho: a, nome: 'A', id: 'uuid:A', capacidade: 1 })
  await svc.varrer()
  await svc.responder({ caminho: a, nome: 'Aladim', camera: 'FX30' })
  await ocioso()
  const b = cartaoSony({ serial: 'S-1' })
  discos.push({ caminho: b, nome: 'B', id: 'uuid:B', capacidade: 1 })
  await svc.varrer()
  assert.equal(svc.view().pedidos.length, 0)
  await ocioso()
  assert.equal(svc.view().ultimo.pasta, 'Diária 01 / Cenas / Aladim - FX30 / Cartão 02')
  // Outro corpo do mesmo modelo: pergunta, com o dono que tem FX30 sugerido.
  const c = cartaoSony({ serial: 'S-2' })
  discos.push({ caminho: c, nome: 'C', id: 'uuid:C', capacidade: 1 })
  await svc.varrer()
  const v = svc.view()
  assert.equal(v.pedidos.length, 1)
  assert.equal(v.pedidos[0].donoSugerido, v.projeto.donos[0].id)
  await svc.close()
})

test('destino desconectado: a descarga espera e começa sozinha quando ele volta', async () => {
  const { svc, discos, ocioso } = montar()
  await svc.init()
  const pai = tmp('sobedesce-hdpai-')
  const hd = path.join(pai, 'HD Backup')
  fs.mkdirSync(hd)
  await svc.criarProjeto({ nome: 'Doc', destinos: [hd] })
  await svc.ligar(true)
  fs.rmSync(hd, { recursive: true })
  const card = cartaoSony()
  discos.push({ caminho: card, nome: 'SD', id: 'uuid:W', capacidade: 1 })
  await svc.varrer()
  await svc.responder({ caminho: card, nome: 'Bia', camera: '' })
  await esperar(() => svc.view().job?.fase === 'esperando-destino')
  assert.deepEqual(svc.view().job.faltando, ['HD Backup'])
  fs.mkdirSync(hd)
  await ocioso()
  assert.equal(svc.view().ultimo.resultado, 'ok')
  assert.ok(fs.existsSync(path.join(hd, 'Doc', 'Diária 01', 'Cenas', 'Bia', 'Cartão 01', 'PRIVATE/M4ROOT/CLIP/C0001.MP4')))
  await svc.close()
})

test('o HD de destino não vira pedido; "Ignorar este disco" fica guardado; tirar o cartão some com o pedido', async () => {
  const { svc, discos } = montar()
  await svc.init()
  const hd = tmp('sobedesce-hd-')
  await svc.criarProjeto({ nome: 'P', destinos: [path.join(hd, 'Backups')] })
  fs.mkdirSync(path.join(hd, 'Backups'))
  await svc.ligar(true)
  discos.push({ caminho: hd, nome: 'HD', id: 'uuid:HD', capacidade: 1 })
  const outro = tmp()
  discos.push({ caminho: outro, nome: 'Pendrive', id: 'uuid:PEN', capacidade: 1 })
  const card = cartaoSony()
  discos.push({ caminho: card, nome: 'SD', id: 'uuid:SD', capacidade: 1 })
  await svc.varrer()
  let v = svc.view()
  assert.deepEqual(v.pedidos.map((x) => x.nome), ['Pendrive', 'SD'])
  assert.ok(!v.volumes.some((x) => x.nome === 'HD'))
  await svc.responder({ caminho: outro, ignorar: true })
  discos.splice(2, 1) // tira o cartão
  await svc.varrer()
  v = svc.view()
  assert.equal(v.pedidos.length, 0)
  assert.equal(v.projeto.ignorados, 1)
  assert.equal(v.volumes.find((x) => x.nome === 'Pendrive').estado, 'ignorado')
  await svc.close()
})

test('arquivo grande com o mesmo nome e outro tamanho no destino: nunca por cima, vira alerta e não libera formatar', async () => {
  const { svc, discos, ocioso } = montar()
  await svc.init()
  const hd = tmp('sobedesce-hd-')
  await svc.criarProjeto({ nome: 'P', destinos: [hd] })
  await svc.ligar(true)
  const card = cartaoSony({ clipes: 1 })
  escrever(card, 'PRIVATE/M4ROOT/CLIP/GRANDE.MP4', Buffer.alloc(40 * 1024 * 1024 + 10, 1))
  const destino = escrever(path.join(hd, 'P', 'Diária 01', 'Cenas', 'Ana', 'Cartão 01'), 'PRIVATE/M4ROOT/CLIP/GRANDE.MP4', Buffer.alloc(100, 9))
  discos.push({ caminho: card, nome: 'SD', id: 'uuid:G', capacidade: 1 })
  await svc.varrer()
  await svc.responder({ caminho: card, nome: 'Ana', camera: '' })
  await ocioso()
  const v = svc.view()
  assert.equal(v.ultimo.resultado, 'falta')
  assert.deepEqual(v.ultimo.listaAlertas, ['PRIVATE/M4ROOT/CLIP/GRANDE.MP4'])
  assert.equal(fs.statSync(destino).size, 100, 'o que estava no destino ficou')
  await svc.close()
})

test('persistência: projeto, donos, cartões e ignorados voltam ao abrir de novo; nova diária e aviso de data', async () => {
  let dia = new Date(2026, 9, 21, 10)
  const { svc, discos, arquivo, ocioso } = montar({ agora: () => dia })
  await svc.init()
  const hd = tmp('sobedesce-hd-')
  await svc.criarProjeto({ nome: 'Festival', destinos: [hd], ejetar: true })
  await svc.ligar(true)
  const card = cartaoSony()
  discos.push({ caminho: card, nome: 'SD', id: 'uuid:P1', capacidade: 1 })
  await svc.varrer()
  await svc.responder({ caminho: card, nome: 'Aladim', camera: 'FX30' })
  await ocioso()
  assert.equal(svc.view().volumes[0].estado, 'ejetado')
  assert.equal(svc.view().projeto.sugerirNovaDiaria, false)
  dia = new Date(2026, 9, 22, 9)
  assert.equal(svc.view().projeto.sugerirNovaDiaria, true)
  await svc.novaDiaria()
  assert.equal(svc.view().projeto.diaria.nome, 'Diária 02')
  await svc.close()

  const de = new BackupService({ arquivo, listar: async () => discos, vigiaMs: 0, keepAwake: sem, ejetar: async () => true, agora: () => dia })
  const v = await de.init()
  assert.equal(v.ligado, true)
  assert.equal(v.projeto.nome, 'Festival')
  assert.equal(v.projeto.diaria.nome, 'Diária 02')
  assert.equal(v.projeto.historico.length, 1)
  // O mesmo cartão na diária nova: reconhecido, Cartão 01 da Diária 02.
  await de.varrer()
  await esperar(() => !de.rodando && !de.fila.length && de.view().ultimo)
  assert.equal(de.view().ultimo.pasta, 'Diária 02 / Cenas / Aladim - FX30 / Cartão 01')
  assert.ok(JSON.parse(fs.readFileSync(arquivo, 'utf8')).projetos[0].cartoes['uuid:P1'])
  await de.close()
})

test('validação: nome e destinos', async () => {
  const { svc } = montar()
  await svc.init()
  await assert.rejects(svc.criarProjeto({ nome: '  ', destinos: [tmp()] }), /nome/)
  await assert.rejects(svc.criarProjeto({ nome: 'X', destinos: [] }), /destino/)
  const a = tmp()
  await assert.rejects(svc.criarProjeto({ nome: 'X', destinos: [a, path.join(a, 'b')] }), /dentro/)
  await assert.rejects(svc.ligar(true), /projeto/)
  await assert.rejects(svc.ejetar('/qualquer/caminho'), /espetado/, 'só ejeta disco que o vigia viu')
  await svc.close()
})

test('cache dos discos: o que já estava montado não roda o comando de novo; o que saiu e voltou é lido de novo', async () => {
  let entradas = [{ name: 'SD' }]
  let chamadas = 0
  const fsFalso = { readdir: async () => entradas, lstat: async () => ({ isSymbolicLink: () => false }) }
  const exec = async () => (chamadas++, `<key>VolumeUUID</key><string>U${chamadas}</string>`)
  const cache = new Map()
  const ler = () => listarVolumes({ platform: 'darwin', fs: fsFalso, exec, cache })
  assert.equal((await ler())[0].id, 'uuid:U1')
  assert.equal((await ler())[0].id, 'uuid:U1')
  assert.equal(chamadas, 1)
  entradas = []
  assert.deepEqual(await ler(), [])
  entradas = [{ name: 'SD' }]
  assert.equal((await ler())[0].id, 'uuid:U2', 'outro cartão no mesmo caminho é lido de novo')
})
