// "Entre computadores" (docs/LAN.md): rotas, a chave de recepção deste computador (<dados>/lan.json), o receptor na
// rede local (liga com o ajuste lanReceber) e o aviso de presença ao site a cada minuto (endereços + porta + chave,
// só para os computadores da mesma conta). Andamento pelo SSE 'lan'.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LanReceptor } from '../lan/receptor.js'
import { LanEnviador } from '../lan/enviador.js'
import { novaChave, novoPar } from '../lan/cripto.js'
import { lanAddresses } from '../mobile/net.js'
import { computerName } from '../google/cloud-auth.js'
import { planUploads } from '../engine/planner.js'

const PRESENCA_MS = 60_000

/**
 * As chaves deste computador, sorteadas uma vez e guardadas só para este usuário do sistema: a de recepção (mesma
 * conta) e o par X25519 (outras contas cifram para a pública).
 */
function chavesGuardadas(arquivo) {
  let j = {}
  try {
    j = JSON.parse(fs.readFileSync(arquivo, 'utf8')) || {}
  } catch {}
  let mudou = false
  if (typeof j.chave !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(j.chave)) (j.chave = novaChave()), (mudou = true)
  if (!j.par?.publica || !j.par?.privada) (j.par = novoPar()), (mudou = true)
  if (mudou) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true })
    fs.writeFileSync(arquivo, JSON.stringify({ chave: j.chave, par: j.par }), { mode: 0o600 })
  }
  return j
}

/**
 * @param {{ route, ctx, account, HttpProblem, receptor?, enviador? }} o
 * @returns {{ view(): object, close(): Promise<void> }}
 */
export function registerLan({ route, ctx, account, HttpProblem, receptor, enviador }) {
  const dataRoot = ctx.paths?.root || path.dirname(ctx.paths?.settings || '.')
  const arquivoChave = path.join(dataRoot, 'lan.json')
  let chaves = null
  const minhaChave = () => (chaves ??= chavesGuardadas(arquivoChave)).chave
  const meuPar = () => (chaves ??= chavesGuardadas(arquivoChave)).par
  // Sobe a pasta (recebida ou mandada) para o Drive pelo motor de sempre, na fila de Transferências.
  const subirPasta = async ({ caminhos, accountId, folderId, folderName, driveId }) => {
    const acc = account(accountId)
    const plan = await planUploads({ drive: ctx.manager.driveFor(acc.id), accountId: acc.id, paths: caminhos, destFolderId: folderId || 'root', driveId: driveId || null })
    if (plan.batch) plan.batch.destino = folderName || null
    if (plan.records?.length) await ctx.manager.add({ batch: plan.batch, records: plan.records })
    return { arquivos: plan.records?.length || 0 }
  }
  let nome = null
  const meuNome = async () => (nome ??= await computerName())
  const cloud = () => ctx.auth?.cloud || null
  const avisar = () => ctx.hub?.send('lan', view())

  const rec =
    receptor ||
    new LanReceptor({
      settings: ctx.settings,
      chave: minhaChave,
      par: meuPar,
      aceitaOutros: () => !!ctx.settings.get().lanOutros,
      nome: meuNome,
      onChange: avisar,
      onSubirDrive: subirPasta,
      onPedido: (p) => ctx.hub?.send('lan-pedido', p),
      onFim: (o) => ctx.hub?.send('toast', { kind: o.erros ? 'warning' : 'success', message: `${o.pessoa ? `${o.pessoa} (${o.de})` : o.de}: ${o.prontos} de ${o.arquivos} arquivos chegaram em ${o.pasta}.` }),
      log: ctx.log,
    })
  const env =
    enviador ||
    new LanEnviador({
      cloud: cloud(),
      nome: meuNome,
      pessoa: () => (cloud()?.status?.()?.usuario?.nome || '').trim().split(/\s+/)[0] || null,
      onChange: avisar,
      log: ctx.log,
      // "Subir pro Drive ao mesmo tempo": o envio de sempre (retomável), na fila de transferências.
      subirDrive: subirPasta,
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
      await c.request('POST', '/api/lan/presenca', { body: { v: 1, enderecos, porta: rec.porta, chave: minhaChave(), chavePublica: meuPar().publica, outros: !!ctx.settings.get().lanOutros } })
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
    else if (changed.includes('lanOutros')) publicar().then(avisar)
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
    return { ...rec.view(), receber: !!ctx.settings.get().lanReceber, outros: !!ctx.settings.get().lanOutros, conectado: !!cloud()?.signedIn, ...env.view() }
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

  // Resposta a um pedido de outra conta: aceitar (com o Drive desta conta, se quiser) ou recusar.
  route('POST', '/api/lan/responder', tratar(async ({ body }) => {
    if (typeof body.id !== 'string' || !body.id) throw new HttpProblem(400, 'Pedido inválido.')
    let drive = null
    if (body.aceitar === true && body.drive && typeof body.drive === 'object') {
      const acc = account(body.drive.accountId)
      drive = { accountId: acc.id, folderId: typeof body.drive.folderId === 'string' && body.drive.folderId ? body.drive.folderId : 'root', folderName: typeof body.drive.folderName === 'string' ? body.drive.folderName.slice(0, 255) : null, driveId: typeof body.drive.driveId === 'string' ? body.drive.driveId : null }
    }
    try {
      return rec.responder(body.id, body.aceitar === true, { drive })
    } catch (err) {
      if (err?.name === 'LanError') throw new HttpProblem(err.status, err.message)
      throw err
    }
  }))

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
