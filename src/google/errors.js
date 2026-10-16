// Classifica erros (rede, HTTP, Google) em decisões que o motor sabe tomar.
import { HttpError } from '../net/http.js'
import { isAbortError } from '../util/backoff.js'

/**
 * Tipos:
 *  - 'abort'    : pausa/cancelamento pedido pelo usuário. Não é erro.
 *  - 'retry'    : falha temporária (rede caiu, 5xx, limite de requisições). Tentar de novo com recuo.
 *  - 'auth'     : token expirou (401). Renovar token e tentar de novo uma vez.
 *  - 'reauth'   : a conta precisa ser reconectada (refresh token revogado/expirado).
 *  - 'quota'    : cota do Google estourou (ex.: 750 GB/dia de upload, cota de download do arquivo).
 *                 Esperar bastante (retryAfterMs) e retomar sozinho.
 *  - 'notfound' : arquivo/sessão não existe mais.
 *  - 'fatal'    : não adianta repetir (sem permissão, disco cheio, Drive cheio...).
 *
 * @typedef {{kind:'abort'|'retry'|'auth'|'reauth'|'quota'|'notfound'|'fatal', reason:string|null, message:string, retryAfterMs:number|null, status:number|null}} ErrorInfo
 */

const RETRYABLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'backendError',
  'internalError',
  'transientError',
])

// Motivos de cota que não passam em segundos: melhor esperar e retomar depois.
const QUOTA_REASONS = {
  dailyLimitExceeded: { ms: 60 * 60_000, msg: 'Limite diário da API do Google atingido. Vou tentar de novo mais tarde.' },
  uploadLimitExceeded: { ms: 60 * 60_000, msg: 'Você atingiu o limite de upload do Google (750 GB por dia). Retomo sozinho mais tarde.' },
  downloadQuotaExceeded: { ms: 60 * 60_000, msg: 'O Google bloqueou downloads deste arquivo por excesso de acessos. Tento de novo mais tarde.' },
}

const FATAL_REASONS = {
  storageQuotaExceeded: 'Seu Google Drive está sem espaço.',
  quotaExceeded: 'Seu Google Drive está sem espaço.',
  teamDriveFileLimitExceeded: 'Este drive compartilhado atingiu o limite de arquivos.',
  numChildrenInNonRootLimitExceeded: 'Esta pasta do Drive atingiu o limite de itens.',
  insufficientFilePermissions: 'Sua conta não tem permissão para isso neste arquivo/pasta.',
  insufficientPermissions: 'Sua conta não tem permissão para isso.',
  appNotAuthorizedToFile: 'O app não tem permissão para este arquivo.',
  domainPolicy: 'A política da sua organização bloqueia esta ação.',
  cannotDownloadAbusiveFile: 'O Google marcou este arquivo como suspeito e bloqueou o download.',
  fileNotDownloadable: 'Este arquivo não pode ser baixado (o dono bloqueou downloads).',
  cannotCopyFile: 'O dono bloqueou cópias/downloads deste arquivo.',
  exportSizeLimitExceeded: 'Documento do Google grande demais para exportar (limite de 10 MB do Google).',
  accessNotConfigured: 'A Google Drive API não está ativada no seu projeto do Google Cloud. Ative em console.cloud.google.com/apis/library/drive.googleapis.com.',
  SERVICE_DISABLED: 'A Google Drive API não está ativada no seu projeto do Google Cloud. Ative em console.cloud.google.com/apis/library/drive.googleapis.com.',
  activeItemCreationLimitExceeded: 'Sua conta atingiu o limite de itens do Google Drive.',
  fileSizeLimitExceeded: 'Arquivo maior que o limite do Google Drive (5 TB).',
}

// Erros do servidor de OAuth (token/consentimento).
const OAUTH_REASONS = {
  invalid_client: 'O Google não reconheceu sua chave (Client ID/secret). Confira a chave em Ajustes ou crie outra.',
  deleted_client: 'O Google apagou ou desativou seu cliente OAuth (fica inativo após 6 meses sem uso). Restaure em Google Auth Platform → Clientes ou crie outro.',
  unauthorized_client: 'Sua chave não é do tipo "App para computador". Crie um cliente desse tipo no Google Cloud.',
  admin_policy_enforced: 'O administrador do Google Workspace bloqueou este app. Peça para ele liberar o Client ID (Admin → Segurança → Controles de API).',
  org_internal: 'Este app está como "Interno" e só aceita contas da sua organização.',
  access_denied: 'O acesso foi negado. Se o app está em modo Teste, adicione seu e-mail em Público-alvo → Usuários de teste.',
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED', 'UND_ERR_DESTROYED', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'STALLED', // nosso: conexão travou sem trafegar bytes
])

const DISK_CODES = {
  ENOSPC: 'Disco cheio. Libere espaço e retome.',
  EDQUOT: 'Cota de disco atingida. Libere espaço e retome.',
  EACCES: 'Sem permissão para gravar nessa pasta.',
  EPERM: 'Sem permissão para gravar nessa pasta.',
  EROFS: 'O disco de destino é somente leitura.',
  ENAMETOOLONG: 'Nome ou caminho longo demais para o sistema.',
}

/** @returns {ErrorInfo} */
export function classifyError(err) {
  if (isAbortError(err)) return info('abort', null, 'Interrompido.')
  if (err?.kind && err?.message && err.name === 'SobeDesceError') {
    return { kind: err.kind, reason: err.reason ?? null, message: err.message, retryAfterMs: err.retryAfterMs ?? null, status: err.status ?? null }
  }

  if (err instanceof HttpError) {
    const { status, reason } = err
    if (reason === 'invalid_grant') return info('reauth', reason, 'O acesso a esta conta expirou. Conecte a conta de novo.', status)
    if (reason && OAUTH_REASONS[reason]) return info('fatal', reason, OAUTH_REASONS[reason], status)
    if (status === 401) return info('auth', reason, 'Sessão do Google expirou, renovando…', status)
    if (reason && QUOTA_REASONS[reason]) {
      const q = QUOTA_REASONS[reason]
      return info('quota', reason, q.msg, status, err.retryAfterMs ?? q.ms)
    }
    if (reason && FATAL_REASONS[reason]) return info('fatal', reason, FATAL_REASONS[reason], status)
    if (status === 429 || (status === 403 && RETRYABLE_REASONS.has(reason))) {
      return info('retry', reason || 'rateLimitExceeded', 'O Google pediu para ir mais devagar. Tentando de novo…', status, err.retryAfterMs)
    }
    if (status === 404) return info('notfound', reason, 'Não achei no Google Drive: foi apagado, foi para a lixeira ou esta conta perdeu o acesso.', status)
    if (status === 410) return info('notfound', reason, 'A sessão expirou.', status)
    if (status === 408 || status >= 500) return info('retry', reason, `O Google respondeu com erro ${status}. Tentando de novo…`, status, err.retryAfterMs)
    if (status === 403) return info('fatal', reason, err.message || 'Acesso negado pelo Google.', status)
    return info('fatal', reason, err.message || `Erro ${status} do Google.`, status)
  }

  const code = err?.code || err?.cause?.code
  if (code && DISK_CODES[code] && (err.syscall || err.path)) return info('fatal', code, DISK_CODES[code])
  if (code && NETWORK_CODES.has(code)) {
    const offline = code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH' || code === 'ENETDOWN'
    return info('retry', code, offline ? 'Sem internet. Retomo assim que a conexão voltar…' : 'A conexão caiu. Reconectando…')
  }
  if (err?.name === 'TypeError' && /fetch failed|terminated|other side closed/i.test(err.message)) {
    return info('retry', 'network', 'A conexão caiu. Reconectando…')
  }
  if (/other side closed|socket hang up|terminated/i.test(err?.message || '')) return info('retry', 'network', 'A conexão caiu. Reconectando…')
  return info('fatal', code || null, err?.message || 'Erro inesperado.')
}

function info(kind, reason, message, status = null, retryAfterMs = null) {
  return { kind, reason: reason ?? null, message, retryAfterMs: retryAfterMs ?? null, status }
}

/** Erro próprio do app, já classificado. */
export class SobeDesceError extends Error {
  constructor(kind, message, { reason = null, retryAfterMs = null, status = null } = {}) {
    super(message)
    this.name = 'SobeDesceError'
    this.kind = kind
    this.reason = reason
    this.retryAfterMs = retryAfterMs
    this.status = status
  }
}

/** Atalho: erro de conexão travada (sem bytes por stallTimeoutMs). */
export function stalledError() {
  const err = new Error('A conexão travou. Reconectando…')
  err.code = 'STALLED'
  return err
}
