// Backup Automático (docs/BACKUP-AUTOMATICO.md): os discos montados agora (cartões, SSDs, HDs externos), um id que
// reconhece o mesmo cartão na próxima vez que ele for espetado, e ejetar.
//   - macOS: /Volumes (sem a raiz, que é um atalho, sem ocultos); id = VolumeUUID do `diskutil info -plist`; pula o
//     disco interno do Mac e imagem de disco (.dmg). O cartão no leitor SD embutido também se diz "interno": entra,
//     porque é removível.
//   - Windows: letras D: a Z:; id = número de série do volume (`vol`, "XXXX-XXXX", em qualquer idioma); rótulo e tipo
//     pelo PowerShell (pula CD/DVD e unidade de rede).
//   - Linux: /media/$USER e /run/media/$USER; id = UUID do `findmnt`.
// Sem id do sistema: rótulo + capacidade (o mesmo cartão sem formatar continua com os dois).
// Tudo injetável (plataforma, leitura de pastas, comandos) para os testes.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const CMD_MS = 6000

/** Roda um comando e devolve a saída (texto); erro ou demora → null. */
export function rodar(cmd, args, { timeout = CMD_MS } = {}) {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => ok(err ? null : String(stdout || '')))
  })
}

/** `diskutil info -plist`: o que importa da saída (XML). */
export function lerPlistDiskutil(xml) {
  const s = String(xml || '')
  const texto = (k) => new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(s)?.[1] ?? null
  const inteiro = (k) => {
    const v = new RegExp(`<key>${k}</key>\\s*<integer>(\\d+)</integer>`).exec(s)?.[1]
    return v ? Number(v) : null
  }
  const sim = (k) => new RegExp(`<key>${k}</key>\\s*<true\\s*/>`).test(s)
  return {
    uuid: texto('VolumeUUID'),
    nome: texto('VolumeName'),
    protocolo: texto('BusProtocol'),
    interno: sim('Internal'),
    // O leitor de SD embutido (MacBook Pro, Mac Studio) diz "Internal" mas o cartão é removível e ejetável.
    removivel: sim('RemovableMedia') || sim('Removable') || sim('Ejectable') || sim('RemovableMediaOrExternalDevice'),
    capacidade: inteiro('TotalSize') ?? inteiro('Size'),
  }
}

/** Disco do próprio Mac (o SSD interno, uma partição do Boot Camp): não é cartão. O cartão no leitor embutido é. */
export function eDoSistemaMac(info) {
  if (/disk image/i.test(info?.protocolo || '')) return true
  if (!info?.interno) return false
  return !info.removivel && !/secure digital|sd card/i.test(info.protocolo || '')
}

/** Número de série do `vol X:` ("Volume Serial Number is 1A2B-3C4D" / "Número de Série do Volume é 1A2B-3C4D"). */
export function serialDoVol(saida) {
  return /\b([0-9A-F]{4}-[0-9A-F]{4})\b/i.exec(String(saida || ''))?.[1]?.toUpperCase() ?? null
}

/** JSON do `Get-Volume` (um objeto ou uma lista com um). */
export function lerGetVolume(json) {
  try {
    let v = JSON.parse(String(json || ''))
    if (Array.isArray(v)) v = v[0]
    if (!v || typeof v !== 'object') return null
    const tipo = typeof v.DriveType === 'string' ? v.DriveType : ({ 2: 'Removable', 3: 'Fixed', 4: 'Network', 5: 'CD-ROM' })[v.DriveType] || null
    return { nome: typeof v.FileSystemLabel === 'string' ? v.FileSystemLabel : null, tipo, capacidade: Number(v.Size) || null }
  } catch {
    return null
  }
}

async function capacidadeDe(caminho) {
  try {
    const s = await fsp.statfs(caminho)
    return Number(s.blocks) * Number(s.bsize)
  } catch {
    return null
  }
}

const idReserva = (nome, capacidade) => `rotulo:${String(nome || '').trim()}:${capacidade || 0}`

/**
 * Os discos montados agora (sem os do sistema).
 * `cache` (Map caminho → disco): o vigia passa o mesmo a cada 3 s, para não rodar diskutil/PowerShell de novo para o
 * que já estava montado; o que sumiu sai do cache (outro cartão no mesmo caminho depois é lido de novo).
 * @returns {Promise<Array<{ caminho: string, nome: string, id: string, capacidade: number|null }>>}
 */
export async function listarVolumes({ platform = process.platform, fs = fsp, exec = rodar, usuario = os.userInfo().username, cache = null } = {}) {
  const c = cache || new Map()
  const lista = platform === 'darwin' ? await listarMac({ fs, exec, c }) : platform === 'win32' ? await listarWindows({ fs, exec, c }) : await listarLinux({ fs, exec, usuario, c })
  const agora = new Set(lista.map((v) => v.caminho))
  for (const k of [...c.keys()]) if (!agora.has(k) && !c.get(k)?.vivo) c.delete(k)
  for (const v of c.values()) delete v.vivo
  return lista
}

/** Lê o disco uma vez e guarda (null = do sistema, pular); `vivo` marca o que ainda está montado nesta passada. */
async function doCache(c, caminho, ler) {
  if (!c.has(caminho)) c.set(caminho, { info: await ler() })
  const e = c.get(caminho)
  e.vivo = true
  return e.info
}

async function listarMac({ fs, exec, c }) {
  let nomes = []
  try {
    nomes = await fs.readdir('/Volumes', { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of nomes) {
    const nome = e.name
    if (nome.startsWith('.') || nome === 'com.apple.TimeMachine.localsnapshots') continue
    const caminho = path.posix.join('/Volumes', nome)
    try {
      // A raiz ("Macintosh HD") aparece em /Volumes como atalho para "/".
      if ((await fs.lstat(caminho)).isSymbolicLink()) continue
    } catch {
      continue
    }
    const v = await doCache(c, caminho, async () => {
      const info = lerPlistDiskutil(await exec('/usr/sbin/diskutil', ['info', '-plist', caminho]))
      if (eDoSistemaMac(info)) return null
      const capacidade = info.capacidade ?? (await capacidadeDe(caminho))
      return { caminho, nome: info.nome || nome, id: info.uuid ? `uuid:${info.uuid}` : idReserva(nome, capacidade), capacidade }
    })
    if (v) out.push({ ...v })
  }
  return out
}

async function listarWindows({ fs, exec, c }) {
  const out = []
  for (let cod = 'D'.charCodeAt(0); cod <= 'Z'.charCodeAt(0); cod++) {
    const letra = String.fromCharCode(cod)
    const caminho = `${letra}:\\`
    try {
      await fs.stat(caminho)
    } catch {
      continue
    }
    const v = await doCache(c, caminho, async () => {
      const info = lerGetVolume(
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Volume -DriveLetter ${letra} | Select-Object FileSystemLabel,DriveType,Size | ConvertTo-Json -Compress`]),
      )
      if (info?.tipo && /cd-rom|network/i.test(info.tipo)) return null
      const serial = serialDoVol(await exec('cmd.exe', ['/d', '/c', `vol ${letra}:`]))
      const nome = info?.nome || `Disco ${letra}`
      const capacidade = info?.capacidade ?? (await capacidadeDe(caminho))
      return { caminho, nome, id: serial ? `serial:${serial}` : idReserva(nome, capacidade), capacidade }
    })
    if (v) out.push({ ...v })
  }
  return out
}

async function listarLinux({ fs, exec, usuario, c }) {
  const out = []
  for (const base of [`/media/${usuario}`, `/run/media/${usuario}`]) {
    let nomes = []
    try {
      nomes = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of nomes) {
      if (e.name.startsWith('.')) continue
      const caminho = path.posix.join(base, e.name)
      const v = await doCache(c, caminho, async () => {
        const uuid = ((await exec('findmnt', ['-no', 'UUID', caminho])) || '').trim().split('\n')[0] || null
        const capacidade = await capacidadeDe(caminho)
        return { caminho, nome: e.name, id: uuid ? `uuid:${uuid}` : idReserva(e.name, capacidade), capacidade }
      })
      if (v) out.push({ ...v })
    }
  }
  return out
}

/** Ejeta o disco (o cartão pode sair com segurança). Devolve true se o sistema aceitou. */
export async function ejetar(caminho, { platform = process.platform, exec = rodar } = {}) {
  if (platform === 'darwin') return (await exec('/usr/sbin/diskutil', ['eject', caminho], { timeout: 20_000 })) != null
  if (platform === 'win32') {
    const letra = /^([a-z]):/i.exec(caminho)?.[1]?.toUpperCase()
    if (!letra) return false
    const cmd = `(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${letra}:').InvokeVerb('Eject')`
    return (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 20_000 })) != null
  }
  return (await exec('gio', ['mount', '-e', caminho], { timeout: 20_000 })) != null
}
