// "Entre computadores" (docs/LAN.md): rotas, a chave de recepção deste computador (<dados>/lan.json), o receptor na
// rede local (liga com o ajuste lanReceber) e o aviso de presença ao site a cada minuto (endereços + porta + chave,
// só para os computadores da mesma conta). Andamento pelo SSE 'lan'.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LanReceptor } from '../lan/receptor.js'
import { LanEnviador } from '../lan/enviador.js'
import { novaChave } from '../lan/cripto.js'
import { lanAddresses } from '../mobile/net.js'
import { computerName } from '../google/cloud-auth.js'
import { planUploads } from '../engine/planner.js'

const PRESENCA_MS = 60_000

/** A chave de recepção: sorteada uma vez e guardada só para este usuário do sistema. */
function chaveGuardada(arquivo) {
  try {
    const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'))
    if (typeof j.chave === 'string' && /^[A-Za-z0-9_-]{43}$/.test(j.chave)) return j.chave
  } catch {}
  const chave = novaChave()
  fs.mkdirSync(path.dirname(arquivo), { recursive: true })
  fs.writeFileSync(arquivo, JSON.stringify({ chave }), { mode: 0o600 })
  return chave
}

/**
 * @param {{ route, ctx, account, HttpProblem, receptor?, enviador? }} o
 * @returns {{ view(): object, close(): Promise<void> }}
 */
export function registerLan({ route, ctx, account, HttpProblem, receptor, enviador }) {
  const dataRoot = ctx.paths?.root || path.dirname(ctx.paths?.settings || '.')
  const arquivoChave = path.join(dataRoot, 'lan.json')
  let chave = null
  const minhaChave = () => (chave ??= chaveGuardada(arquivoChave))
  let nome = null
  const meuNome = async () => (nome ??= await computerName())
  const cloud = () => ctx.auth?.cloud || null
  const avisar = () => ctx.hub?.send('lan', view())

  const rec =
    receptor ||
    new LanReceptor({
      settings: ctx.settings,
      chave: minhaChave,
      nome: meuNome,
      onChange: avisar,
      onFim: (o) => ctx.hub?.send('toast', { kind: o.erros ? 'warning' : 'success', message: `${o.de}: ${o.prontos} de ${o.arquivos} arquivos chegaram em ${o.pasta}.` }),
      log: ctx.log,
    })
  const env =
    enviador ||
    new LanEnviador({
      cloud: cloud(),
      nome: meuNome,
      onChange: avisar,
      log: ctx.log,
      // "Subir pro Drive ao mesmo tempo": o envio de sempre (retomável), na fila de transferências.
      subirDrive: async ({ caminhos, accountId, folderId, folderName, driveId }) => {
        const acc = account(accountId)
        const plan = await planUploads({ drive: ctx.manager.driveFor(acc.id), accountId: acc.id, paths: caminhos, destFolderId: folderId || 'root', driveId: driveId || null })
        if (plan.batch) plan.batch.destino = folderName || null
        if (plan.records?.length) await ctx.manager.add({ batch: plan.batch, records: plan.records })
        return { arquivos: plan.records?.length || 0 }
      },
    })
  if (!env.cloud) env.cloud = cloud()

  // ───── receptor + presença ─────

  let timer = null
  let publicado = false
  let mudando = Promise.resolve()
  const publicar = async () => {
    const c = cloud()
    if (!c?.signedIn || !rec.rodando) return
    const enderecos = lanAddresses().slice(0, 8)
    if (!enderecos.length) return
    try {
      await c.request('POST', '/api/lan/presenca', { body: { v: 1, enderecos, porta: rec.porta, chave: minhaChave() } })
      publicado = true
    } catch (err) {
      ctx.log?.('lan: presença', err?.message || err)
    }
  }
  const despublicar = async () => {
    const c = cloud()
    if (!publicado || !c?.signedIn) return
    publicado = false
    await c.request('DELETE', '/api/lan/presenca', { expect: [204, 200, 404] }).catch(() => {})
  }
  const sincronizar = () =>
    (mudando = mudando.then(async () => {
      const quer = !!ctx.settings.get().lanReceber
      try {
        if (quer && !rec.rodando) await rec.iniciar()
        if (!quer && rec.rodando) {
          await despublicar()
          await rec.parar()
        }
      } catch (err) {
        ctx.log?.('lan: receptor', err?.message || err)
        ctx.hub?.send('toast', { kind: 'error', message: `Não deu para receber pela rede (${err.code || err.message}).` })
      }
      clearInterval(timer)
      timer = null
      if (rec.rodando) {
        await publicar()
        timer = setInterval(publicar, PRESENCA_MS)
        timer.unref?.()
      }
      avisar()
    }))
  const onSettings = (_next, changed = []) => {
    if (changed.includes('lanReceber')) sincronizar()
    else if (changed.includes('lanPorta') && rec.rodando) {
      mudando = mudando.then(() => rec.parar())
      sincronizar()
    }
  }
  ctx.settings.on?.('change', onSettings)
  // Entrou na conta depois de abrir o app: avisa a presença já.
  const onConta = () => sincronizar()
  cloud()?.on?.('status', onConta)
  sincronizar()

  function view() {
    return { ...rec.view(), receber: !!ctx.settings.get().lanReceber, conectado: !!cloud()?.signedIn, ...env.view() }
  }

  const tratar = (fn) => async (a) => {
    try {
      return await fn(a)
    } catch (err) {
      if (err?.name === 'EnvioError') throw new HttpProblem(err.status && err.status >= 400 ? err.status : 409, err.message)
      if (err?.name === 'SobeDesceError' || err?.name === 'HttpError') throw new HttpProblem(503, 'O site da conta SOBEDESCE não respondeu agora.')
      throw err
    }
  }

  route('GET', '/api/lan', tratar(async () => view()))

  route('GET', '/api/lan/computadores', tratar(async () => {
    if (!cloud()?.signedIn) return { conectado: false, computadores: [] }
    return env.computadores()
  }))

  route('POST', '/api/lan/enviar', tratar(async ({ body }) => {
    if (!cloud()?.signedIn) throw new HttpProblem(409, 'Entre na sua conta SOBEDESCE para mandar para outro computador.')
    if (typeof body.para !== 'string' || !body.para) throw new HttpProblem(400, 'Escolha o computador.')
    const origens = Array.isArray(body.origens) ? body.origens.filter((x) => typeof x === 'string' && x).slice(0, 500) : []
    if (!origens.length) throw new HttpProblem(400, 'Escolha o que mandar.')
    for (const o of origens) {
      try {
        await fsp.stat(o)
      } catch {
        throw new HttpProblem(404, `Não achei ${o}.`)
      }
    }
    let drive = null
    if (body.drive && typeof body.drive === 'object') {
      const acc = account(body.drive.accountId)
      drive = { accountId: acc.id, folderId: typeof body.drive.folderId === 'string' && body.drive.folderId ? body.drive.folderId : 'root', folderName: typeof body.drive.folderName === 'string' ? body.drive.folderName.slice(0, 255) : null, driveId: typeof body.drive.driveId === 'string' ? body.drive.driveId : null }
    }
    return env.enviar({ para: body.para, origens, pasta: typeof body.pasta === 'string' ? body.pasta.slice(0, 120) : '', drive })
  }))

  route('POST', '/api/lan/cancelar', tratar(async () => env.cancelar()))

  route('POST', '/api/lan/limpar', tratar(async () => env.limpar()))

  return {
    view,
    close: async () => {
      clearInterval(timer)
      ctx.settings.off?.('change', onSettings)
      cloud()?.off?.('status', onConta)
      await env.close()
      await despublicar()
      await rec.parar()
    },
  }
}
