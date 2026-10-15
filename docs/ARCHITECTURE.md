# SOBEDESCE — Arquitetura e contratos

> Documento de referência para quem mexe no código. Os contratos abaixo são a fonte da verdade:
> cada módulo implementa exatamente a interface descrita aqui.

## Visão geral

SOBEDESCE é um app local: um **motor em Node.js** (roda na máquina do usuário, com acesso ao disco e
várias conexões TCP) + uma **interface web** servida em `http://127.0.0.1:4317`. Nada passa por
servidor nosso: o tráfego vai direto da máquina para o Google.

```
navegador (UI Preact+htm)  ──HTTP/SSE──▶  src/server  ──▶  TransferManager ──▶ DownloadTask / UploadTask
                                              │                 │                      │
                                              ├─▶ Comparator    ├─▶ Hasher (worker)    └─▶ net/http (undici, HTTP/1.1)
                                              ├─▶ local/fs      └─▶ queue.json                    │
                                              └─▶ AuthManager / DriveClient  ──────────────────────▶ Google Drive API
```

Por que é rápido:
- **Download segmentado**: cada arquivo é baixado por N conexões HTTP/1.1 independentes (Range),
  cada uma com sua própria janela TCP. Quando uma termina, ela "rouba" metade do maior pedaço
  restante (como IDM/aria2), então todas as conexões trabalham até o último byte.
- **Conexões lentas são refeitas**: o Google às vezes estrangula uma conexão; se uma fica muito
  abaixo da mediana das outras, ela é reaberta.
- **Upload**: o Drive só aceita os bytes de UM arquivo em ordem (uma requisição por vez por arquivo),
  então o paralelismo vem de vários arquivos ao mesmo tempo. Por padrão cada arquivo vai num fluxo
  contínuo (uma requisição do ponto onde parou até o fim — recomendação do Google, sem pausas entre
  pedaços). Um fluxo único costuma render ~40–100 MB/s; 4 arquivos simultâneos enchem links de 1 Gbps.
- **Nada se perde**: o progresso é gravado em disco (gravação atômica). Downloads guardam a posição
  de cada segmento (só posições já sincronizadas com `fdatasync`); uploads guardam a URL da sessão
  retomável e perguntam ao Google quanto já chegou.

## Layout

```
src/
  index.js               entrada: sobe servidor, abre navegador, encerra com pausa limpa
  config.js              caminhos, endpoints, Settings (ajustes vivos)          [pronto]
  util/store.js          JSON atômico, JsonFile com saveSoon                       [pronto]
  util/backoff.js        backoffDelay, sleep(ms, signal), isAbortError, abortError [pronto]
  util/meter.js          SpeedMeter, eta                                           [pronto]
  util/limiter.js        BandwidthLimiter (token bucket)                           [pronto]
  util/ids.js            newId(prefix)                                             [pronto]
  util/paths.js          nomes seguros para o disco local, junção de caminhos relativos
  net/http.js            httpRequest, requestJSON, HttpError, drain, closeHttp     [pronto]
  google/errors.js       classifyError, SobeDesceError, stalledError                   [pronto]
  google/oauth.js        AuthManager (OAuth loopback + PKCE, multi-conta)
  google/drive.js        DriveClient (listar, árvore, pastas, metadados)
  engine/hasher.js       Hasher (MD5 em worker thread + cache por caminho/tamanho/mtime)
  engine/hash-worker.js  código do worker
  engine/download.js     DownloadTask (segmentado, retomável)
  engine/upload.js       UploadTask (sessão retomável)
  engine/planner.js      expande seleções (pastas) em registros de transferência
  engine/manager.js      TransferManager (fila, concorrência, persistência, eventos)
  engine/compare.js      compareFolders (local × Drive)
  engine/power.js        KeepAwake (impede o computador de dormir)
  local/fsbrowse.js      raízes (Início, Mesa, discos externos) e listagem de pastas
  local/scan.js          varredura recursiva local
  server/app.js          servidor HTTP, segurança, estáticos, SSE
  server/routes.js       rotas da API
public/                  UI (Preact + htm sem build; vendor servido de node_modules)
test/mock-drive.js       Google Drive + OAuth falsos (com falhas e limite de banda por conexão)
scripts/demo.js          sobe o app ligado ao Drive falso, com arquivos de exemplo (sem credenciais)
```

## Convenções

- ESM, Node ≥ 20.18, JavaScript puro (JSDoc quando ajudar). Sem TypeScript, sem bundler.
- Dependências: só `undici`, `preact`, `htm`. Não adicionar outras sem necessidade real.
- Mensagens para o usuário em **português do Brasil**, tom humano e curto.
- Caminhos relativos (`relPath`, `relDir`) sempre com `/`, normalizados em **Unicode NFC**
  (macOS pode devolver nomes em NFD; o Drive guarda NFC). `relDir` da raiz é `''`.
- Tamanhos em bytes (number). Datas em ISO string ou epoch ms (`*Ms`).
- Todo I/O longo aceita `signal` (AbortSignal). Abort = pausa/cancelamento, nunca erro para o usuário.
- Endpoints do Google SEMPRE via `endpoints()` de `config.js` (os testes apontam para o mock).
- Testes: `node:test` + `node:assert/strict`, arquivos `test/*.test.js`, usando `test/mock-drive.js`
  e `SOBEDESCE_HOME` num diretório temporário. Teste lento (> 10 s) tem `slow` no nome.

## Contratos

### util/paths.js

```js
export function toNFC(s): string
export function joinRel(...parts): string            // 'a', 'b/c' -> 'a/b/c' (ignora vazios)
export function splitRel(rel): string[]               // 'a/b/c' -> ['a','b','c']; '' -> []
export function safeLocalName(name, platform = process.platform): string
  // troca caracteres inválidos (<>:"/\|?* e controle no Windows; '/' e ':' no mac/linux) por '_',
  // remove pontos/espaços no fim (Windows), evita nomes reservados (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
  // acrescentando '_', limita a 240 bytes UTF-8 preservando a extensão. Nunca devolve '' / '.' / '..'.
export function uniqueName(name, taken: Set<string>): string   // 'a.mov' -> 'a (2).mov' se ocupado (case-insensitive)
export function isJunkFile(name): boolean             // .DS_Store, ._*, Thumbs.db, desktop.ini, *.sobedesce-part, Icon\r, .Spotlight-V100, .Trashes, .fseventsd
export const PART_SUFFIX = '.sobedesce-part'
```

### google/oauth.js — `AuthManager extends EventEmitter`

Credenciais do cliente OAuth (tipo "App para computador") ficam em `credentials.json`
(`{ clientId, clientSecret }`). Contas em `accounts.json` (modo 0600):
`{ accounts: [{ id, email, name, photoUrl, refreshToken, addedAt, status }] }`.
`id` = `permissionId` do usuário (via `GET {driveApi}/about?fields=user`).

```js
new AuthManager({ paths = dataPaths() })
async init()
hasClientCredentials(): boolean
getClientInfo(): { configured: boolean, clientIdHint: string|null }      // hint = '1234…apps.googleusercontent.com'
async setClientCredentials(input)   // aceita o JSON baixado do Console ({installed:{client_id,client_secret}} ou {web:{...}}),
                                    // string JSON, ou { clientId, clientSecret }. Valida formato; lança Error PT-BR.
listAccounts(): Array<{ id, email, name, photoUrl, addedAt, status: 'ok'|'reauth' }>   // nunca expõe tokens
beginLogin(redirectUri): { url, state }     // PKCE S256 (verifier = base64url(randomBytes(64))), state aleatório,
                                            // access_type=offline, prompt=consent, scope = DRIVE_SCOPE (sem include_granted_scopes).
                                            // Guarda verifier por state (expira em 15 min).
async completeLogin({ code, state, redirectUri, error }): account
    // `error` do callback (ex.: access_denied) vira mensagem PT-BR. Troca code por tokens SEMPRE enviando
    // client_secret (clientes Desktop ainda exigem). Confere se `scope` da resposta contém o escopo do Drive
    // (consentimento granular: o usuário pode desmarcar) — senão erro "Marque a permissão do Google Drive".
    // Sem refresh_token na resposta = falha. Busca about.user, salva/atualiza conta com consentedAt.
async getAccessToken(accountId, { forceRefresh = false } = {}): string
    // cache em memória; renova se faltar < 120 s; renovações concorrentes da mesma conta compartilham a promessa;
    // invalid_grant => status 'reauth', emite 'accounts', lança SobeDesceError('reauth', ...).
    //   Se aconteceu ~7 dias após consentedAt, a mensagem explica o modo Teste do Google Cloud
    //   ("publique o app em Público-alvo → Publicar app, ou reconecte toda semana").
    // Nunca sobrescreve o refresh token salvo com undefined. Erros de rede no endpoint de token: retry com backoff.
async removeAccount(accountId)              // revoga (melhor esforço) e apaga
// eventos: 'accounts' (lista pública)
```

### google/drive.js — `DriveClient`

```js
new DriveClient(auth: AuthManager, accountId: string)
async api(method, pathOrUrl, { query, body, headers, signal, expect, retries = 6 } = {}): any
    // monta URL em endpoints().driveApi (ou usa URL absoluta), põe Authorization, supportsAllDrives=true.
    // 401 -> getAccessToken(forceRefresh) e repete uma vez. 'retry' -> backoffDelay + repete até `retries`.
    // Outros erros: lança (HttpError/SobeDesceError) — quem chama classifica com classifyError.
async authHeader(): { authorization: 'Bearer …' }
async about(): { user: { email, name, photoUrl, permissionId }, quota: { limit|null, usage, usageInDrive } }
async listSharedDrives(): Array<{ id, name }>
async getItem(fileId, { signal }): DriveItem
async listChildren(folderId, { signal }): DriveItem[]           // pagina tudo (pageSize 1000), trashed=false, ordena pastas primeiro + nome
async getPath(folderId): Array<{ id, name }>                     // breadcrumb da raiz até a pasta (cache)
async walk(folderId, { signal, onProgress, concurrency = 8 }): { root: DriveItem, items: DriveItem[] }
    // varre a árvore inteira; cada item ganha relPath relativo à pasta (sem o nome da raiz) e relDir.
    // Pastas aparecem nos items. Atalhos para ARQUIVO são resolvidos (item.target = DriveItem do alvo);
    // atalhos para pasta NÃO são seguidos (evita ciclos). onProgress({ folders, files, bytes }).
async findChild(parentId, name, { folder = null, signal } = {}): DriveItem|null   // escapa ' e \ na query
async createFolder(name, parentId, { signal }): DriveItem
async ensureFolderPath(rootId, relDir, { signal, cache }): string
    // cria/acha cada nível de relDir dentro de rootId e devolve o id da última pasta.
    // `cache` (Map) guarda promessas por `${rootId}/${prefixo}` para criação concorrente não duplicar pastas.
async search(text, { signal }): DriveItem[]                       // name contains, até 200 resultados
// Detalhes obrigatórios (ver docs/GOOGLE-NOTES.md):
//  - supportsAllDrives=true em TODA chamada files.*; includeItemsFromAllDrives=true em files.list;
//    pageSize=1000; dentro de drive compartilhado use corpora=drive&driveId=<id>.
//  - `fields` sempre explícito (about.get EXIGE fields).
//  - Itens com resourceKey: mandar header 'X-Goog-Drive-Resource-Keys: <id>/<resourceKey>' (helper resourceKeyHeader(item)).
//  - Limitador interno das chamadas de metadados: no máx. 8 simultâneas e ~20 req/s (token bucket);
//    em 403/429 de limite, reduz pela metade e volta a subir devagar.
//  - NÃO mandar Accept-Encoding: gzip (undici.request não descompacta).
mediaUrl(fileId): string        // {driveApi}/files/{id}?alt=media&supportsAllDrives=true&acknowledgeAbuse=false
exportUrl(fileId, mimeType): string
uploadInitUrl(): string         // {driveUpload}/files?uploadType=resumable&supportsAllDrives=true&fields=…
uploadUpdateUrl(fileId): string // {driveUpload}/files/{id}?uploadType=resumable&supportsAllDrives=true&fields=…

DriveItem = { id, name, mimeType, size: number|null, md5: string|null, modifiedTime: string|null,
              headRevisionId: string|null, resourceKey: string|null, canDownload: boolean,
              parents: string[], driveId: string|null, isFolder, isGoogleDoc, isShortcut,
              shortcutTargetId: string|null, shortcutTargetMimeType: string|null,
              relPath?: string, relDir?: string, target?: DriveItem }
FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,headRevisionId,resourceKey,parents,driveId,' +
              'shortcutDetails(targetId,targetMimeType,targetResourceKey),capabilities(canDownload)'
GOOGLE_EXPORTS = { 'application/vnd.google-apps.document': { mime: '…wordprocessingml.document', ext: '.docx' },
                   spreadsheet -> .xlsx, presentation -> .pptx, drawing -> .png ; outros google-apps: não baixáveis }
```

### engine/hasher.js — `Hasher`

```js
new Hasher({ cacheFile = dataPaths().hashCache, workers = 2 })
async init()
getCached(path, size, mtimeMs): string|null
async hash(path, { signal, onProgress } = {}): string     // md5 hex; usa cache se path+size+mtime batem; roda em worker_threads
async flush()
async close()                                             // encerra workers
```
Cache: `{ [absPath]: { size, mtimeMs, md5 } }`, salvo com `saveSoon`. Lê o arquivo em blocos de 4 MiB.

### Registro de transferência (persistido em `queue.json`)

```js
TransferRecord = {
  id, type: 'download'|'upload', accountId, batchId,
  status: 'queued'|'running'|'verifying'|'paused'|'waiting'|'completed'|'skipped'|'failed'|'canceled',
  name, relPath,                // relPath p/ exibição (dentro do lote)
  size,                         // bytes (null só em export de Google Docs antes de começar)
  bytesDone,                    // confirmado em disco (download) / no Google (upload)
  createdAt, startedAt, finishedAt, updatedAt,   // epoch ms
  error: null | { message, reason, kind, at },
  retryAt: null | epoch ms,     // status 'waiting' (cota): quando tentar de novo
  attempts: number,             // falhas seguidas sem progresso (zera quando progride)
  verify: null | { state: 'pending'|'running'|'ok'|'mismatch'|'skipped', expected, actual },
  note: null | string,          // ex.: 'Já estava no Drive', 'Exportado como .docx'

  // download
  source?: { fileId, mimeType, md5, modifiedTime, export?: { mime, ext } },
  dest?:   { path, tempPath },                    // absolutos; tempPath = path + PART_SUFFIX
  segments?: Array<{ start, end, pos }>,          // end inclusivo; pos = próximo byte a buscar (durável)

  // upload
  local?:  { path, size, mtimeMs },
  target?: { rootId, relDir, parentId|null, driveId|null, replaceFileId|null, fileId|null },
  session?: null | { uri, createdAt, offset },    // offset = bytes confirmados pelo Google
}
```

### Contexto passado às tarefas

```js
TaskContext = {
  drive: DriveClient,              // da conta do registro
  settings: Settings,              // settings.get() a cada decisão
  limiter: BandwidthLimiter,       // da direção (down/up), global
  hasher: Hasher,
  folderCache: Map,                // (upload) para ensureFolderPath
  persist(): void,                 // pede gravação (debounced) — chamar após mudar o registro
  onBytes(n): void,                // bytes que trafegaram agora (alimenta velocidade global e do item)
  log(...args): void,
}
```

### engine/download.js — `DownloadTask extends EventEmitter`

```js
new DownloadTask(record, ctx)
async run(signal): void
  // Resolve quando completed/skipped. Abort => grava posições duráveis, fecha arquivo, rejeita com AbortError.
  // Erro fatal/quota => rejeita com o erro original (o manager classifica e marca o registro).
liveSegments(): Array<{ start, end, pos, active: boolean, speed: number }>   // para a UI (posições ao vivo)
speed(): number
```
Algoritmo:
0. `size === 0`: cria o arquivo vazio sem nenhuma requisição (Range em arquivo vazio falha).
1. Google Doc nativo (`source.export`): uma conexão, sem Range, escreve no tempPath e renomeia.
2. Revalida metadados (`getItem`): se `md5`/`size`/`headRevisionId` mudou desde a criação do registro,
   zera segmentos e recomeça (senão juntaria pedaços de duas versões). Confere espaço livre (`fs.statfs`) >= bytes restantes, senão fatal ENOSPC.
3. Abre `tempPath` (`r+` se existe e segmentos têm progresso, senão cria e `truncate(size)` → arquivo esparso).
   Se o arquivo temporário sumiu ou é menor que `size`, recomeça do zero.
4. Segmentos iniciais: `n = clamp(ceil(size / minSegmentSize), 1, connectionsPerDownload)` partes iguais.
5. Workers (até `connectionsPerDownload`): pegam segmento livre; sem livre, **roubam** a metade do
   maior restante (se restam > 32 MiB nele) — encolhem `end` do dono e criam novo segmento `[meio, endAntigo]`.
   O dono para quando `pos > end` (conferido a cada pedaço recebido).
6. GET `mediaUrl` com `Range: bytes=pos-end` (+ header de resourceKey se houver), exige 206 com
   `Content-Range` começando em `pos` (200 só é aceito se pos === 0 — e aí o arquivo vira 1 conexão só;
   qualquer outra divergência: descarta o corpo e tenta de novo, NUNCA grava bytes no lugar errado). Corpo em
   stream: agrupa até 1 MiB, `await limiter.take`, `fh.write(buf, 0, len, pos)`, avança `pos` ao vivo.
   `ctx.onBytes` a cada pedaço recebido.
7. Travamento: sem bytes por `stallTimeoutMs` → aborta a requisição (erro STALLED, retry).
   Conexão lenta: depois de 15 s de vida, se `restartSlowConnections` e a velocidade dela < 25% da
   mediana das demais por 10 s seguidos → reabre a partir da posição atual (não conta como falha;
   no máximo uma vez a cada 30 s por worker).
8. Erros por worker: 'retry' → `backoffDelay(tentativas)` e reabre; 'auth' → força refresh e reabre;
   tentativas zeram quando há progresso; > 10 falhas seguidas sem progresso → falha a tarefa.
   'fatal'/'quota'/'notfound'/'reauth' → aborta todos os workers e rejeita.
   `downloadQuotaExceeded` (cota do arquivo) chega como 'quota': o manager reagenda com atraso crescente
   (15 min, 1 h, 4 h, 24 h) e os outros arquivos seguem.
   416 → se o segmento já está completo segue; senão o arquivo mudou: recomeça do zero.
9. Checkpoint a cada 2 s: `await fh.datasync()`, copia `pos` vivo → `record.segments[i].pos`,
   atualiza `record.bytesDone`, `ctx.persist()`. Só posições sincronizadas são persistidas.
10. Fim: fecha, `verify` (se `verifyChecksums` e houver `md5`): status 'verifying', `hasher.hash`;
    diferente → apaga temp, zera segmentos e falha com `verify.state='mismatch'` (retry recomeça).
    Igual → `rename(tempPath, path)` (se `path` passou a existir, usa `uniqueName`), aplica
    `utimes` com `modifiedTime` do Drive. `status` final fica com o manager.

### engine/upload.js — `UploadTask extends EventEmitter`

```js
new UploadTask(record, ctx)
async run(signal): void          // mesmas regras de resolve/reject do DownloadTask
speed(): number
```
Algoritmo:
1. `stat(local.path)`: sumiu → fatal. Tamanho/mtime mudou desde o plano → descarta sessão, atualiza `local`, recomeça.
2. Pasta de destino: `target.parentId ??= drive.ensureFolderPath(rootId, relDir, { cache: ctx.folderCache })`.
3. Conflito (sem sessão e sem `replaceFileId`): `findChild(parentId, name)`; se existe arquivo com o
   mesmo tamanho → conforme `uploadConflict`: 'skip' (se md5 local = md5 remoto, ou sem md5 remoto e
   mesmo tamanho) → `record.status='skipped'`, `note='Já estava no Drive'`, resolve; 'replace' →
   `replaceFileId = existente.id`; 'rename' → sobe com nome `uniqueName`.
4. Sessão: se não há (ou tem > 6 dias — a URI expira em 1 semana): POST `uploadInitUrl()` (ou PATCH `uploadUpdateUrl(replaceFileId)`)
   com `{ name, parents:[parentId] (só no create), modifiedTime: ISO(mtime) }`,
   headers `X-Upload-Content-Type` (pelo nome; padrão application/octet-stream) e
   `X-Upload-Content-Length`. Guarda `Location` em `session.uri` e persiste NA HORA.
   A URI da sessão é uma credencial: nunca vai para a UI nem para logs (mascare `upload_id`).
   Mesmo assim, toda requisição leva `Authorization` atualizado (inofensivo, como o rclone faz).
5. Se havia sessão: consulta status (PUT vazio, `Content-Range: bytes */size`): 308 + `Range: bytes=0-N`
   → offset N+1 (sem Range → 0); 200/201 → já terminou; 404/410 → sessão morreu → nova sessão, offset 0.
6. Envio: a partir de `offset`, PUT de `[offset, fim]` onde fim = offset + chunk − 1 (`uploadChunkSize`,
   múltiplo de 256 KiB; **0 = tudo que falta, o padrão**), `Content-Range: bytes a-b/size`, corpo = `fs.createReadStream`
   (highWaterMark 1 MiB) passando pelo limiter + `onBytes` + detector de travamento.
   308 → novo offset = o que o **Google** disse no `Range` (pode ser menor que o enviado); persiste.
   200/201 → JSON do arquivo (`id, md5Checksum, size`): `target.fileId`, `verify.actual`.
   Falha 'retry' → backoff, consulta status, continua do offset do Google.
   308 é resposta normal do protocolo (não seguir como redirecionamento). Se um 308 trouxer `Location`, troque a URI.
7. Arquivo vazio (size 0): sessão + PUT com `Content-Length: 0` e sem corpo.
8. Verificação: se `verifyChecksums`, começa `hasher.hash(local.path)` em paralelo ao envio; no fim compara
   com `md5Checksum` devolvido. Diferente → `verify.state='mismatch'` e falha (o arquivo no Drive fica, a UI avisa).
9. Pausa: aborta o PUT atual; a sessão continua válida (≈ 1 semana); retomar = passo 5.
10. Cota de 750 GB/dia: o Google responde 403 `userRateLimitExceeded` ("User rate limit exceeded."), igual a
    um limite de taxa comum. Regra: se o MESMO upload recebe esse erro 5 vezes seguidas sem nenhum progresso
    (ou 3 vezes seguidas ao abrir sessão), lança `SobeDesceError('quota', 'Você atingiu o limite de upload
    do Google (750 GB por dia)…', { reason: 'uploadLimitExceeded', retryAfterMs: 60 min })`.
    O arquivo que cruza o limite termina; os próximos esperam.
11. Tamanho > 5 TB (5.497.558.138.880 bytes): fatal antes de começar.

### engine/planner.js

```js
async planDownloads({ drive, accountId, items: DriveItem[], destDir, conflict, batchId, signal, onProgress })
  : { batch, records: TransferRecord[], skipped: Array<{ name, reason }> }
async planUploads({ drive, accountId, paths: string[], destFolderId, driveId, conflict, batchId, signal, onProgress })
  : { batch, records, skipped }
planUploadsFromCompare(compareResult, { accountId, statuses, relDirs }): { batch, records }
planDownloadsFromCompare(compareResult, { accountId }): { batch, records }
Batch = { id, type, label, createdAt, accountId }   // label: 'Pasta Projeto X' / '12 arquivos'
```
Downloads: pastas viram `destDir/<nome da pasta>/<relPath>`; nomes passam por `safeLocalName` e
`uniqueName` (o Drive permite nomes repetidos na mesma pasta). Docs nativos usam `GOOGLE_EXPORTS`;
outros `google-apps.*` vão para `skipped`, assim como `canDownload === false` ("O dono bloqueou downloads").
Atalho para arquivo baixa o alvo. Conflito com arquivo local
existente: 'skip' (mesmo tamanho → não cria registro, vai para skipped), 'rename', 'overwrite'.
Uploads: arquivo > 5 TB vai para `skipped`; se a soma do lote passa do espaço livre do Drive
(`about().quota`, quando há limite) o resultado inclui `warnings: ['…']` (não bloqueia).
Uploads: pasta selecionada sobe como `<destFolderId>/<nome da pasta>/...`; ignora `isJunkFile` e links
simbólicos; arquivos soltos vão direto em `destFolderId`.

### engine/manager.js — `TransferManager extends EventEmitter`

```js
new TransferManager({ settings, auth, hasher, paths = dataPaths(), driveFactory = (accountId) => DriveClient })
async init()                    // carrega queue.json; 'running'/'verifying' viram 'queued' (autoResume) ou 'paused'
snapshot(): { transfers: PublicTransfer[], batches: Batch[], stats: Stats }
add({ batch, records }): void   // persiste e agenda
pause(ids|'all'), resume(ids|'all'), cancel(ids), retry(ids), remove(ids), prioritize(ids): Promise<void>
pauseBatch(batchId), resumeBatch(batchId), cancelBatch(batchId)
clearFinished(): void           // remove completed/skipped/canceled
async shutdown()                // pausa tudo, espera workers, grava
stats(): Stats
// eventos: 'transfers' (PublicTransfer[] alterados, no máximo 4×/s), 'removed' (ids), 'stats' (Stats, 2×/s), 'batches'
PublicTransfer = registro sem tokens/sessão + { speed, eta, segments: liveSegments() (≤ 32, só download ativo) }
Stats = { down: { speed, active, queued }, up: { speed, active, queued }, totals: { count, bytes, doneBytes },
          eta, history: Array<{ t, down, up }> (últimos 120 s, 1 ponto/s), keepAwake: boolean,
          usage: { [accountId]: { up24h, down24h } } }   // bytes nas últimas 24 h (cota de 750 GB/dia de upload)
```
Livro-razão de uso: a cada byte confirmado, soma no balde da hora atual por conta/direção
(`usage.json`, guarda 25 h) → `stats.usage` mostra "612 de 750 GB nas últimas 24 h".
Agendamento: respeita `maxConcurrentDownloads` / `maxConcurrentUploads` (lidos ao vivo), ordem da fila
(prioridade, depois createdAt). Ao concluir/falhar, agenda o próximo. Erros: 'retry' (estourou tentativas)
→ 'failed'; 'quota' → 'waiting' com `retryAt` e reagenda sozinho; 'reauth' → 'paused' com erro
"Conecte a conta de novo"; 'fatal'/'notfound' → 'failed'. `cancel` de download apaga o `tempPath`;
de upload faz DELETE na sessão (melhor esforço). Limites de banda e KeepAwake seguem `settings`.

### engine/compare.js

```js
async compareFolders({ drive, localPath, driveFolderId, mode: 'quick'|'deep', hasher, signal, onProgress })
  : CompareResult
CompareResult = {
  id, createdAt, mode, localPath, drive: { folderId, name, path: string },
  summary: { files, bytes, synced, missing, missingBytes, different, differentBytes, onlyDrive, onlyDriveBytes, elsewhere },
  folders: Array<{ relDir, name, depth, files, bytes, synced, missing, missingBytes, different, onlyDrive, state: 'complete'|'partial'|'missing'|'empty' }>,
  files: Array<{ relPath, relDir, name, status: 'synced'|'missing'|'different'|'only-drive'|'elsewhere',
                 local?: { size, mtimeMs }, remote?: { id, size, md5, path }, note?: string }>,
}
```
Regras: casa por `relPath` em NFC; se não achar, tenta sem diferenciar maiúsculas (nota). 'quick' = mesmo
tamanho; 'deep' = mesmo MD5 (hash local com cache). Local sem par: procura o mesmo conteúdo em qualquer
lugar da pasta do Drive (md5 no deep; nome+tamanho no quick) → 'elsewhere' com o caminho remoto;
senão 'missing'. Remoto sem par local → 'only-drive' (Docs nativos ignorados). `folders` agrega a
**subárvore** de cada pasta (local ∪ remota), com `relDir=''` para a raiz; ordenado por caminho.
Progresso: `onProgress({ phase: 'local'|'drive'|'hash'|'match', done, total, current })`.

### local/fsbrowse.js e local/scan.js

```js
listRoots(): Promise<Array<{ name, path, kind: 'home'|'desktop'|'downloads'|'documents'|'movies'|'volume'|'drive' }>>
  // mac: Início, Mesa, Downloads, Filmes + /Volumes/* (discos externos); win: letras A-Z existentes; linux: /media/$USER/*, /mnt/*
listDir(path, { showHidden }): Promise<{ path, parent|null, entries: Array<{ name, path, isDir, size, mtimeMs }> }>
statPaths(paths): Promise<Array<{ path, isDir, size, exists }>>
scanLocal(rootPath, { signal, onProgress }): Promise<{ root: { path, name, isDir }, files: Array<{ relPath, relDir, name, path, size, mtimeMs }>, dirs: string[] }>
  // relPath relativo À PASTA (sem o nome dela); se rootPath é arquivo, files = [ele] com relPath = nome.
  // ignora isJunkFile, links simbólicos e pastas sem permissão (conta em skipped).
```

### engine/power.js

```js
new KeepAwake()
setActive(active: boolean)    // mac: spawn('caffeinate', ['-dims', '-w', pid]); linux: systemd-inhibit se existir;
                              // win: powershell com SetThreadExecutionState; falha silenciosa
get active(): boolean
stop()
```

### Servidor (src/server) — API

Escuta em `127.0.0.1`, porta `SOBEDESCE_PORT` ou 4317 (se ocupada, tenta as próximas 20).
Segurança: rejeita `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>` (DNS rebinding);
métodos que alteram estado exigem `Content-Type: application/json` e, se houver `Origin`, que seja a do app.
Respostas JSON `{ ok: true, ... }` ou `{ ok: false, error: 'mensagem PT-BR' }` com status 4xx/5xx.

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | `/api/state` | | `{ app:{name,version,platform}, setup:{configured, clientIdHint}, accounts, settings, transfers, batches, stats }` |
| POST | `/api/setup/credentials` | `{ json }` ou `{ clientId, clientSecret }` | `{ setup }` |
| GET | `/api/auth/start` | | 302 para o Google (redirect_uri = `http://127.0.0.1:<porta>/oauth/callback`) |
| GET | `/oauth/callback` | `code, state` | página HTML "Conta conectada" que volta para `/` |
| DELETE | `/api/accounts/:id` | | `{ accounts }` |
| GET | `/api/drive/:acc/about` | | `{ about }` |
| GET | `/api/drive/:acc/drives` | | `{ drives }` |
| GET | `/api/drive/:acc/list` | `folderId` (padrão `root`) | `{ folder, path, items }` |
| GET | `/api/drive/:acc/search` | `q` | `{ items }` |
| POST | `/api/drive/:acc/folders` | `{ parentId, name }` | `{ item }` |
| GET | `/api/local/roots` | | `{ roots, home, sep }` |
| GET | `/api/local/list` | `path`, `hidden` | `{ path, parent, entries }` |
| POST | `/api/transfers/download` | `{ accountId, items: DriveItem[], destDir?, conflict? }` | `{ batch, count, bytes, skipped }` |
| POST | `/api/transfers/upload` | `{ accountId, paths, destFolderId, driveId?, conflict? }` | `{ batch, count, bytes, skipped }` |
| POST | `/api/transfers/action` | `{ action: pause|resume|cancel|retry|remove|prioritize, ids?: string[]|'all', batchId? }` | `{ }` |
| POST | `/api/transfers/clear` | | `{ }` |
| GET | `/api/settings` / PATCH `/api/settings` | patch | `{ settings }` |
| POST | `/api/compare` | `{ accountId, localPath, driveFolderId, mode }` | `{ jobId }` (progresso via SSE) |
| GET | `/api/compare/:jobId` | | `{ status, progress, result?, error? }` |
| POST | `/api/compare/:jobId/upload` | `{ statuses?: ['missing','different'], relDirs?: string[] }` | `{ batch, count, bytes }` |
| POST | `/api/compare/:jobId/download` | `{ relDirs?: string[] }` | `{ batch, count, bytes }` |
| POST | `/api/reveal` | `{ path }` | abre no Finder/Explorer |
| GET | `/api/events` | | SSE |

SSE (`text/event-stream`, `event:` + `data:` JSON, ping a cada 15 s):
`hello` (= `/api/state`), `transfers` (PublicTransfer[] alterados), `removed` (ids), `batches`,
`stats`, `accounts`, `settings`, `compare` (`{ jobId, status, progress, error? }`), `toast` (`{ kind, message }`).

### Interface (public/)

Preact + htm sem build (`/vendor/preact-htm.js` = `node_modules/htm/preact/standalone.module.js`).
Telas: **Transferências** (medidor ao vivo ↓/↑ com gráfico dos últimos 2 min, lotes agrupados,
barra de progresso que mostra os segmentos como clipes numa timeline de edição, pausar/retomar/cancelar,
filtros), **Drive** (navegar Meu Drive e drives compartilhados, selecionar e baixar, enviar para a pasta
atual), **Comparar** (pasta local × pasta do Drive, árvore com o que falta por pasta, botão
"Subir o que falta"), **Ajustes**, e **Primeiros passos** (configurar credenciais Google + conectar conta).
Seletor de pastas/arquivos locais próprio (modal) usando `/api/local/*`.

### O que a interface espera do servidor (decidido ao construir a UI)

- `/api/local/list?hidden=1` liga arquivos ocultos (ausente = desligado).
- `path` em `/api/drive/:acc/list` é o breadcrumb da raiz até a pasta atual, incluindo a atual. Drive compartilhado
  é navegado com `folderId` = id do drive. Upload na raiz manda `destFolderId: 'root'` (+ `driveId` quando for drive compartilhado).
- Eventos SSE podem vir como array puro ou embrulhados (`{ transfers: [...] }`); `batches` substitui a lista inteira,
  `transfers` mescla por id. Evento opcional `setup` (`{ configured, clientIdHint }`) também é tratado.
- Status de comparação: `running` → `done` | `error` | `canceled`. A UI também consulta `GET /api/compare/:jobId` a cada 2,5 s.
- `PublicTransfer.priority` (opcional; maior = primeiro) ordena a fila na UI, depois `createdAt`.
- Item pausado com `error.kind === 'reauth'` mostra "Conectar de novo" (→ `/api/auth/start`).
- Limites de banda na UI são MB/s decimais (× 1e6); pedaço de upload em MiB (0 = contínuo).
- Servir de `public/`: `/favicon.svg`, `/lib/*`, `/components/*`, `/app.js`, `/styles.css`. Sem scripts inline (CSP estrita funciona).
- Depois do OAuth, o callback leva para `/` (a UI recarrega `/api/state`).

## App de desktop (Electron) — contrato com `src/index.js`

O app de desktop (`desktop/`) reaproveita o motor inteiro: o processo principal do Electron sobe o motor com
`utilityProcess.fork('src/index.js')` e abre uma janela apontando para a URL local. Por isso `src/index.js` precisa:

- Exportar `startApp({ home, port, open = true }) → { url, port, manager, shutdown() }` (usado pelo demo e pelos testes).
- Quando rodar como processo filho do Electron (`process.parentPort` existe):
  - não abrir navegador; usar a porta de `SOBEDESCE_PORT` (o Electron passa 0 = porta livre);
  - depois que o servidor estiver ouvindo: `process.parentPort.postMessage({ type: 'ready', url, port })`;
  - ao receber `{ type: 'shutdown' }` (via `process.parentPort.on('message', e => e.data)`): `shutdown()` (pausa tudo,
    grava a fila) e `process.exit(0)`;
  - erro fatal na subida: `postMessage({ type: 'fatal', message })` e sair com código 1.
- Com `SOBEDESCE_DESKTOP=1`, a página de retorno do OAuth (aberta no navegador do sistema, porque o Google
  bloqueia login dentro de apps Electron) diz "Conta conectada. Pode voltar para o SOBEDESCE." em vez de
  redirecionar para a interface.

A janela do Electron carrega a mesma interface; `window.sobedesce` (preload) oferece extras nativos:
`{ desktop: true, platform, pickFolder(opts) → string|null, pickPaths(opts) → string[], pathForFile(File) → string,
setProgress(fraction|null, activeCount), notify(title, body), openExternal(url), reveal(path) }`.
A interface usa esses extras quando existem (seletor nativo, arrastar do Finder/Explorer, progresso no Dock/barra de
tarefas) e cai no seletor próprio quando roda no navegador.
