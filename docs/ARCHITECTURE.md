# SOBEDESCE — Arquitetura e contratos

> Documento de referência para quem mexe no código. Os contratos abaixo são a fonte da verdade:
> cada módulo implementa exatamente a interface descrita aqui.

## Visão geral

SOBEDESCE é um app local: um **motor em Node.js** (roda na máquina do usuário, com acesso ao disco e
várias conexões TCP) + uma **interface web** servida em `http://127.0.0.1:4317`. Nenhum byte de arquivo passa
por servidor nosso: o tráfego vai direto da máquina para o Google. Os Drives vêm de dois lugares: da **conta
SOBEDESCE** (o site `web/` guarda os refresh tokens e entrega access tokens ao app; ver `docs/CONTAS.md`) ou de
um OAuth feito **só neste computador** com a chave do próprio usuário.

```
navegador (UI Preact+htm)  ──HTTP/SSE──▶  src/server  ──▶  TransferManager ──▶ DownloadTask / UploadTask
                                              │                 │                      │
                                              ├─▶ Comparator    ├─▶ Hasher (worker)    └─▶ net/http (undici, HTTP/1.1)
                                              ├─▶ local/fs      └─▶ queue.json                    │
                                              └─▶ AuthManager / DriveClient  ──────────────────────▶ Google Drive API
                                                     └─▶ CloudAuth ──HTTPS──▶ sobedesce.vercel.app (/api/drive/token)
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
  util/segredos.js       ArquivoSecreto (segredos com a guarda do sistema: safeStorage no app de desktop), guardaPorMensagens
  util/backoff.js        backoffDelay, sleep(ms, signal), isAbortError, abortError [pronto]
  util/meter.js          SpeedMeter, eta                                           [pronto]
  util/limiter.js        BandwidthLimiter (token bucket)                           [pronto]
  util/ids.js            newId(prefix)                                             [pronto]
  util/paths.js          nomes seguros para o disco local, junção de caminhos relativos
  net/http.js            httpRequest, requestJSON, HttpError, drain, closeHttp     [pronto]
  google/errors.js       classifyError, SobeDesceError, stalledError                   [pronto]
  google/oauth.js        AuthManager (OAuth loopback + PKCE, multi-conta; junta as contas da nuvem)
  google/cloud-auth.js   CloudAuth (conta SOBEDESCE: fluxo de dispositivo, Drives da conta, tokens do site)
  google/drive.js        DriveClient (listar, árvore, pastas, metadados)
  google/folder-size.js  walkFolderSize: soma o tamanho de uma pasta (o Drive não guarda), listagem mínima
  engine/hasher.js       Hasher (MD5 em worker thread + cache por caminho/tamanho/mtime)
  engine/hash-worker.js  código do worker
  engine/stream-hash-worker.js  worker do MD5 que acompanha um download (Hasher.stream)
  engine/download.js     DownloadTask (segmentado, retomável)
  engine/upload.js       UploadTask (sessão retomável)
  engine/planner.js      expande seleções (pastas) em registros de transferência
  engine/manager.js      TransferManager (fila, concorrência, persistência, eventos)
  engine/compare.js      compareFolders (local × Drive)
  engine/power.js        KeepAwake (impede o computador de dormir)
  engine/acompanhar.js   AcompanharCelular: manda o andamento das transferências para a conta (docs/CONTAS.md §9)
  media/raw-thumb.js     miniatura de .braw/.r3d: extrairFrame (Quick Look / Explorer / ajudante nativo) e RawThumbnailer
  media/raw-thumb-lote.js "Gerar miniaturas": RAW que já estão no Drive, achados no computador por nome + tamanho
  media/previa.js        prévia leve: leitura (ffmpeg -i), decisão, linha de comando, detecção do ffmpeg/codificador, conversão
  media/previa-fila.js   GeradorPrevias: fila depois do envio (Proxy/<nome>.mp4 + appProperties), vaga única de conversão
  media/previa-lote.js   "Gerar proxies da pasta" / "Gerar proxy": vídeos que já estão no Drive, achados no computador por nome + tamanho
  server/previas.js      rotas /api/previas* e o lote (SSE 'previas')
  server/tamanho.js      rotas /api/drive/:acc/tamanho (tamanho das pastas: contas guardadas na sessão, fila de 2)
  server/copiar.js       rotas /api/copiar (copiar de um link do Drive para uma pasta da conta; google/copiar.js)
  local/fsbrowse.js      raízes (Início, Mesa, discos externos) e listagem de pastas
  local/scan.js          varredura recursiva local
  referencias/           Referências (vídeos/fotos salvos nas coleções do Drive): plataformas, metadados, cookies,
                         yt-dlp (rodar, atualizar, achar), cliente da API do site e o serviço (ver "Referências")
  celular/wifi.js        CelularWifi: celular ↔ computador pelo Wi-Fi (espera longa no site, pedidos, gravação; docs/CELULAR-WIFI.md)
  server/celular.js      rotas /api/celular* (a interface e a janela oculta do WebRTC, public/celular/)
  server/app.js          servidor HTTP, segurança, estáticos, SSE
  server/routes.js       rotas da API
  version.js             VersionChecker (aviso de versão nova: pergunta ao site /baixar/versao)
  updater.js             Updater ("Atualizar": baixa, confere o SHA-256 e troca o app empacotado)
public/                  UI (Preact + htm sem build; vendor servido de node_modules)
web/                     site com contas SOBEDESCE (Next.js); web/public/app = app do celular em /app/ (docs/CELULAR.md);
                         web/public/instalar.sh e instalar.ps1 = instaladores de uma linha (Mac e Windows)
test/mock-drive.js       Google Drive + OAuth falsos (com falhas e limite de banda por conexão)
test/mock-cloud.js       site de contas falso (docs/CONTAS.md §5) que emite tokens do Drive falso
scripts/build-info.mjs   identidade do build (src/build-info.json e o versao.json do Release de teste)
scripts/sha256.mjs       SHA-256 de um instalador (CI), que vai para o versao.json
scripts/ffmpeg-baixar.mjs baixa o ffmpeg do instalador (versões fixas + SHA-256) para build/ffmpeg/<mac|win>-<arch>/
scripts/demo.js          sobe o app ligado ao Drive falso, com arquivos de exemplo (sem credenciais);
                         SOBEDESCE_DEMO_HOME troca a pasta do demo (só apaga pasta vazia ou com a marca .sobedesce-demo)
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
(`{ clientId, clientSecret }`). Contas em `accounts.json` (modo 0600; com a guarda do sistema, `accounts.cifrado.json`,
ver "Segredos no disco"):
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

Integração com a conta SOBEDESCE: `new AuthManager({ paths, cloud })`. `listAccounts()` devolve as locais
(`source: 'local'`) seguidas das da nuvem (`source: 'nuvem'`, id `nuvem:<id>`); `getAccessToken('nuvem:…')` vai para
`cloud.getAccessToken(<id>)`; `removeAccount('nuvem:…')` recusa (400, "use sobedesce.vercel.app/conta"); o evento
`accounts` também dispara quando a lista da nuvem muda. `close()` para o relógio da nuvem. Sem `cloud`, id `nuvem:` → 'reauth'.
O resto do motor (DriveClient, tarefas, fila com `accountId`) não sabe de onde vem a conta.

### google/cloud-auth.js — `CloudAuth extends EventEmitter`

Cliente da conta SOBEDESCE (contrato em `docs/CONTAS.md` §5 e §7). Base `https://sobedesce.vercel.app`, trocada por
`SOBEDESCE_CLOUD_URL` (só https, ou http em 127.0.0.1/localhost; `cloudUrl()` em `config.js`).

```js
new CloudAuth({ paths, baseUrl?, deviceName?, platform?, refreshEveryMs = 5 min, retryBaseMs, pollMs? })
async init()                      // lê cloud.json; com sessão: liga o relógio e atualiza a lista em segundo plano
listAccounts()                    // [{ id: 'nuvem:<id>', email, name, photoUrl, addedAt: null, status: 'ok'|'reauth', source: 'nuvem' }]
status(): CloudStatus             // para a interface; nunca leva token nem segredo
async beginLogin()                // POST /api/dispositivo/iniciar { nome (scutil ComputerName / hostname), plataforma: mac|windows|linux }
                                  //   e começa a consultar /api/dispositivo/aguardar a cada `intervalo` s (429 → mais devagar,
                                  //   410 → 'expirado', rede fora → segue tentando até vencer). Pronto → grava a sessão, lê /api/eu.
cancelLogin()
async refresh({ full })           // GET /api/drive/contas (full ou sem usuário: GET /api/eu). Sem internet: guarda `erro`, mantém a lista.
async getAccessToken(contaId, { forceRefresh, rejectedToken })
    // POST /api/drive/token { conta, renovar? }. Cache em memória até faltar 5 min para `expiraEm`; uma requisição por vez
    // por conta; forceRefresh (o Google deu 401) → renovar: true (se o cache já tem outro token que não o recusado, usa ele).
    // 409 reconectar → conta vira 'reauth', SobeDesceError('reauth', 'Reconecte este Drive em sobedesce.vercel.app/conta',
    // reason 'cloudReconnect'). 404 → 'reauth' (cloudAccountNotFound) e atualiza a lista. Rede/5xx/429 → 'retry' (3 tentativas;
    // a razão é o código de rede, então o DriveClient aplica a janela de "sem internet").
    // 401 em qualquer chamada com o token do dispositivo → sessão revogada: apaga cloud.json, esvazia a lista,
    // status().aviso + evento 'signedOut' (vira toast), erro 'reauth' (reason 'cloudSignedOut').
async signOut()                   // POST /api/dispositivo/sair (melhor esforço) e apaga cloud.json
close()
// eventos: 'accounts' (lista pública), 'status' (CloudStatus), 'signedOut' ({ reason, message })
CloudStatus = { conectado, site, contaUrl, usuario: { id, email, nome }|null, contas: listAccounts(),
                login: { estado: 'nenhum'|'pendente'|'pronto'|'expirado'|'erro', codigo?, url?, expiraEm?, mensagem? },
                atualizadoEm, erro: string|null, aviso: string|null }
```
`cloud.json` (modo 0600, gravação atômica; com a guarda do sistema, `cloud.cifrado.json`, ver "Segredos no disco"):
`{ versao, servidor, token: 'sdd_…', usuario, contas, entrouEm, atualizadoEm }`.
Token de outro `servidor` é ignorado. A lista guardada deixa o app abrir sem internet com as contas da fila no lugar.
Quando a lista muda (Drive reconectado no site), o `TransferManager` volta para a fila o que estava pausado com 'reauth'.

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
async getItem(fileId, { signal, resourceKey, media = false }): DriveItem   // media: também BROWSE_FIELDS (prévia)
async listChildren(folderId, { signal, media = false, driveId, limit }): DriveItem[]  // pagina tudo (pageSize 1000), trashed=false, ordena pastas primeiro + nome; para em `limit`
async getPath(folderId): Array<{ id, name }>                     // breadcrumb da raiz até a pasta (cache)
async walk(folderId, { signal, onProgress, concurrency = 8 }): { root: DriveItem, items: DriveItem[] }
    // varre a árvore inteira; cada item ganha relPath relativo à pasta (sem o nome da raiz) e relDir.
    // Pastas aparecem nos items. Atalhos para ARQUIVO são resolvidos (item.target = DriveItem do alvo);
    // atalhos para pasta NÃO são seguidos (evita ciclos). onProgress({ folders, files, bytes }).
async findChild(parentId, name, { folder = null, signal } = {}): DriveItem|null   // escapa ' e \ na query
async createFolder(name, parentId, { signal }): DriveItem
async ensureFolderPath(rootId, relDir, { signal, cache, onCreated }): string
    // cria/acha cada nível de relDir dentro de rootId e devolve o id da última pasta.
    // onCreated(folderId): avisado quando um nível foi criado agora (pasta nova = vazia).
    // `cache` (Map) guarda promessas por `${rootId}/${prefixo}` para criação concorrente não duplicar pastas.
async search(text, { signal, media = false }): DriveItem[]        // name contains, até 200 resultados
async folderSize(folderId, { signal, onProgress, concurrency = 4 }): { bytes, files, folders, docs, shortcuts, pending: 0, root }
    // o Drive não guarda tamanho de pasta: soma a árvore (google/folder-size.js) com fields=nextPageToken,files(id,mimeType,size),
    // pageSize 1000, sem lixeira, corpora=drive no drive compartilhado. Atalhos não são seguidos (contam em `shortcuts`),
    // Docs do Google contam 0 (em `docs`, dentro de `files`). Subpasta que some no meio fica de fora.
    // Cancelado: AbortError com err.partial. O app do celular faz a mesma conta em web/public/app/lib/tamanho.js.
async listSharedWithMe({ signal, media = true, limit = 1000 }): DriveItem[]   // "Compartilhados comigo": q sharedWithMe = true and trashed = false, sem os de drive compartilhado, pastas primeiro + nome
async rename(fileId, name, { signal }): DriveItem                  // files.update { name }; 403 → SobeDesceError "Sua conta não pode renomear…"
async move(fileId, destId, { signal }): { item: DriveItem, moved }  // files.update addParents=dest&removeParents=<pais atuais> (supportsAllDrives)
    // Já está lá: moved false, sem escrita. Pasta para dentro dela mesma ou de uma subpasta (getPath do destino) e destino
    // que não é pasta: 400 antes de chamar o Google. Raiz do que foi compartilhado comigo (sem pai à vista): 403 "só quem é
    // dono". Recusa do Google: 403 "não pode mover este item para lá" (ou a regra do drive compartilhado/empresa). Limpa os
    // caches de pasta (breadcrumb, ensureFolderPath).
// BROWSE_FIELDS (media: true) também traz capabilities(canEdit,canRename,canAddChildren,canMoveItemWithinDrive,canTrash):
// o DriveItem ganha canRename, canMove, canAddChildren, canTrash (só quando a resposta trouxe) para o menu de contexto.
async setThumbnail(fileId, image: Buffer, mimeType = 'image/jpeg', { signal, retries }): { id, hasThumbnail }
    // PATCH files/{id} com contentHints.thumbnail = { image: base64 URL-safe (RFC 4648 §5, com '='), mimeType }.
    // PNG/JPEG/GIF até 2 MB (valida antes de chamar). O Drive só usa quando não gera a dele; conteúdo novo derruba.
// Detalhes obrigatórios (ver docs/GOOGLE-NOTES.md):
//  - supportsAllDrives=true em TODA chamada files.*; includeItemsFromAllDrives=true em files.list;
//    pageSize=1000; dentro de drive compartilhado use corpora=drive&driveId=<id>.
//  - `fields` sempre explícito (about.get EXIGE fields).
//  - Itens com resourceKey: mandar header 'X-Goog-Drive-Resource-Keys: <id>/<resourceKey>' (helper resourceKeyHeader(item)).
//  - Limitador interno das chamadas de metadados: no máx. 8 simultâneas e ~20 req/s (token bucket);
//    em 403/429 de limite, reduz pela metade e volta a subir devagar.
//  - NÃO mandar Accept-Encoding: gzip (undici.request não descompacta).
//  - Sem conexão nenhuma (ENOTFOUND, EAI_AGAIN, ENETUNREACH, ENETDOWN, EHOSTUNREACH, ECONNREFUSED): repete a cada ~1 s
//    só por `offlineWindowMs` (8 s) e desiste — a interface não fica girando; as tarefas têm a própria espera longa.
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
async remember(path, size, mtimeMs, md5): boolean         // guarda um MD5 já conferido (download: arquivo final, depois do utimes)
stream(path): StreamHash                                  // MD5 que acompanha uma gravação em ordem (um worker próprio, fora do pool)
  // StreamHash: advance(upto) [só cresce; voltar = falha], async finish(size, { signal, onProgress }): md5, close()
async flush()
async close()                                             // encerra workers (e os StreamHash abertos)
```
Cache: `{ [absPath]: { size, mtimeMs, md5 } }`, salvo com `saveSoon`. Lê o arquivo em blocos de 4 MiB.
`stream` lê do DISCO, com leitura síncrona no próprio worker (não ocupa o pool do libuv), só até a frente que o download
avisou; o MD5 cobre os bytes que estão no arquivo, não os que vieram da rede. Não passa pelo cache.

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
  local?:  { path, size, mtimeMs, growing?, stream? },   // growing: ainda chegando do celular (path = .part);
                                                          // stream: veio em fluxo (MD5 sempre conferido no fim)
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
  folderListings?: FolderListings, // (upload) nomes já no Drive por pasta de destino (engine/folder-listings.js)
  persist(): void,                 // pede gravação (debounced) — chamar após mudar o registro
  onBytes(n): void,                // bytes que trafegaram agora (alimenta velocidade global e do item)
  log(...args): void,
  feed?: ReceiveFeed | null,       // (upload com local.growing) arquivo ainda chegando do celular (mobile/receiver.js)
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
   zera segmentos e recomeça (senão juntaria pedaços de duas versões). Exceção: a PRIMEIRA execução de um plano
   recém-feito (`source.checkedAt` < 30 min, com `md5` e `headRevisionId`, sem progresso) pula o `getItem`; a marca
   é de uso único. Se o arquivo mudou depois do plano, o `Content-Range` (tamanho) ou o MD5 do fim denunciam (neste
   caso o MD5 diferente vira `retry`/`remoteChanged`, não `checksumMismatch`). Confere espaço livre (`fs.statfs`) >= bytes restantes, senão fatal ENOSPC.
3. Abre `tempPath` (`r+` se existe e segmentos têm progresso, senão cria e `truncate(size)` → arquivo esparso).
   Se o arquivo temporário sumiu ou é menor que `size`, recomeça do zero.
4. Blocos em ordem: o arquivo começa como um segmento só `[0, size-1]`. Cada worker pega o PRIMEIRO segmento livre e o
   corta em um bloco de `minSegmentSize` (64 MiB; sobra de até meio bloco vai junto); o resto vira um segmento livre
   logo depois. Com 1 conexão (ou servidor sem Range) não corta. Segmentos completos vizinhos se juntam (a lista não
   cresce um item por bloco).
5. Workers (até `connectionsPerDownload`): pegam o próximo bloco livre; só quando não sobra nenhum (o fim do arquivo)
   **roubam** a metade do maior restante (se restam > 32 MiB nele) — encolhem `end` do dono e criam novo segmento
   `[meio, endAntigo]`. O dono para quando `pos > end` (conferido a cada pedaço recebido).
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
9. Checkpoint a cada 10 s OU a cada 1 GiB gravado (o que vier primeiro; era a cada 2 s): `await fh.datasync()`,
   copia `pos` vivo → `record.segments[i].pos`, atualiza `record.bytesDone`, `ctx.persist()`. Só posições sincronizadas
   são persistidas. Numa queda de energia se perdem até ~10 s de progresso (baixa de novo esse trecho); o temporário
   nunca fica errado. Motivo: no macOS o `fdatasync` vira `F_FULLFSYNC` e, em HD externo, segura as gravações.
10. MD5 junto com a gravação (se `verifyChecksums`, houver `md5`, `size > minSegmentSize` e `hasher.stream`): a "frente
    contínua" (fim do maior prefixo já gravado; nada antes dela é reescrito na rodada) vai para `StreamHash.advance` a
    cada tique, a cada bloco completo e no fim da rodada. O worker lê esse trecho do disco logo depois da gravação.
    Retomada (outra tarefa, outro processo): o estado do MD5 não é guardado; a frente começa no prefixo já baixado e o
    worker relê esse prefixo em segundo plano enquanto o resto baixa. Rodada que termina em pausa, erro ou "arquivo
    mudou" fecha o StreamHash (a próxima começa outro, do zero).
11. Fim: fecha, `verify` (se `verifyChecksums` e houver `md5`): status 'verifying'; `StreamHash.finish(size)` (só falta
    o último trecho) ou, sem ele ou se falhou, `hasher.hash` do arquivo inteiro. MD5 da gravação diferente do Drive é
    confirmado com `hasher.hash` antes de qualquer decisão. Diferente → apaga temp, zera segmentos e falha com
    `verify.state='mismatch'` (retry recomeça). Igual → `rename(tempPath, path)` (se `path` passou a existir, usa
    `uniqueName`), aplica `utimes` com `modifiedTime` do Drive e guarda o MD5 do arquivo final no cache do Hasher
    (`hasher.remember`, com o `stat` depois do `utimes`): o Comparar profundo não relê. `status` final fica com o manager.

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
   Com `ctx.folderListings` (o manager sempre passa, um por conta): antes do `findChild`, uma consulta local à
   listagem da pasta (uma `listChildren` por pasta, válida 10 min; pasta criada pelo app nasce vazia, sem listar;
   arquivo criado pelo app entra na hora). "Não tem esse nome" dispensa o `findChild`; "tem" ou "pasta grande demais
   (> 5.000 itens)" faz o `findChild` de sempre, então a decisão de conflito usa dados novos.
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
12. Arquivo ainda chegando do celular (`local.growing` + `ctx.feed`; opções `feedIdleMs` = 20 s, `feedParkMs` = 60 s):
    o tamanho é o declarado e o passo 1 é pulado (o arquivo cresce de propósito). A sessão abre logo; o PUT
    (`[offset, fim]`, como no passo 6) lê do `.part` só até `feed.ready` (bytes contíguos já gravados) e, quando alcança,
    espera o celular com o detector de travamento "segurado" (como no limitador de banda). Celular parado por
    `feedIdleMs` dentro do PUT → fecha o PUT (o Google guarda o que chegou; não conta como falha), consulta o ponto e
    espera fora do PUT; mais `feedParkMs` sem nada novo → `SobeDesceError('retry', …, { reason: 'waitingPhone' })` e o
    manager devolve para 'queued' sem ocupar vaga até chegar algo além de `feed.mark`. Quando o arquivo termina de
    chegar (`feed.complete`: sincronizado e com o nome final), `local.path` passa a ser o arquivo final; o MD5 é sempre
    calculado dele, no fim, e comparado com o `md5Checksum`. Diferente → `reason: 'verifyFailed'` ('retry'): a fila refaz
    sozinha a partir do disco, como nova versão do mesmo arquivo (até 3 vezes). Nunca calcula MD5 de arquivo pela metade.

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
new TransferManager({ settings, auth, hasher, paths = dataPaths(), driveFactory = (accountId) => DriveClient,
                      thumbnailer = new RawThumbnailer({ settings }) })   // null desliga a miniatura de .braw
async init()                    // carrega queue.json; 'running'/'verifying' viram 'queued' (autoResume) ou 'paused'
snapshot(): { transfers: PublicTransfer[], batches: Batch[], stats: Stats }
add({ batch, records }): void   // persiste e agenda
pause(ids|'all'), resume(ids|'all'), cancel(ids), retry(ids), remove(ids), prioritize(ids): Promise<void>
pauseBatch(batchId), resumeBatch(batchId), cancelBatch(batchId)
clearFinished(): void           // remove completed/skipped/canceled
canStartUpload(accountId, size): boolean   // vaga de envio livre agora, ninguém na frente, conta fora do limite diário
attachFeed(id, feed), detachFeed(id)       // recepção do celular em fluxo: envio com local.growing só anda com feed
async shutdown()                // pausa tudo, espera workers, grava
stats(): Stats
// eventos: 'transfers' (PublicTransfer[] alterados, no máximo 4×/s), 'removed' (ids), 'stats' (Stats, 2×/s), 'batches'
PublicTransfer = registro sem tokens/sessão + { speed, eta, segments: liveSegments() (≤ 32, só download ativo),
                 receive?: { bytes, size } (envio em fluxo: quanto já chegou do celular) }
Stats = { down: { speed, active, queued }, up: { speed, active, queued }, totals: { count, bytes, doneBytes },
          eta, history: Array<{ t, down, up }> (últimos 120 s, 1 ponto/s), keepAwake: boolean,
          usage: { [accountId]: { up24h, down24h } } }   // bytes nas últimas 24 h (cota de 750 GB/dia de upload)
```
Gravação da fila: agrupada (`saveSoon`, mais espaçada em filas enormes) e compacta (sem recuo). URI de sessão nova e
download que voltou para trás pedem gravação "logo" (`#saveUrgent`: em 50 ms–1 s, agrupando pedidos simultâneos;
`persist()` devolve a promessa). Sessão que terminou (URI → null) não tem pressa.

Livro-razão de uso: a cada byte confirmado, soma no balde da hora atual por conta/direção
(`usage.json`, guarda 25 h) → `stats.usage` mostra "612 de 750 GB nas últimas 24 h".
Agendamento: respeita `maxConcurrentDownloads` / `maxConcurrentUploads` (lidos ao vivo), ordem da fila
(prioridade, depois createdAt; dentro do mesmo lote de envio, o maior arquivo primeiro). Download por orçamento de
conexões: arquivo grande (≥ 2 × `minSegmentSize`, ou Doc exportado) conta no limite de `maxConcurrentDownloads`;
arquivo pequeno conta as conexões que vai usar, e entram arquivos até `maxConcurrentDownloads × connectionsPerDownload`
conexões e no máximo 16 arquivos. Se o próximo da fila não cabe, ninguém passa na frente dele.
Ao concluir/falhar, agenda o próximo. Erros: 'retry' (estourou as tentativas da tarefa:
internet/Google fora do ar) → 'waiting' com `retryAt` crescente (1, 2, 5, 10, 15 min…; recomeça se houve avanço) e
volta sozinho; depois de 16 esperas seguidas sem avanço → 'failed'; 'quota' → 'waiting' com `retryAt` e reagenda sozinho; 'reauth' → 'paused' com erro
"Conecte a conta de novo"; 'fatal'/'notfound' → 'failed'. `cancel` de download apaga o `tempPath`;
de upload faz DELETE na sessão (melhor esforço). Limites de banda e KeepAwake seguem `settings`.

### engine/acompanhar.js — "Acompanhar pelo celular"

Com a conta SOBEDESCE e o ajuste `acompanharCelular` (padrão ligado; Ajustes → Celular → Em qualquer lugar), manda um
retrato curto das transferências para `POST /api/dispositivos/status` (Bearer do computador, `CloudAuth.request`;
formato em `docs/CONTAS.md` §9). O celular mostra e o site avisa quando termina.

```js
montarRetrato(manager, { rodada: { id, inicio }|null, now, fechado }): StatusComputador
  // membros da rodada: queued/running/verifying/waiting; pausado com updatedAt > inicio; completed/skipped/failed com
  // (finishedAt ?? updatedAt) > inicio. Itens: os ativos/pausados (≤ 50; ao vivo via manager.get para os que rodam),
  // terminados: os 30 últimos dos 7 dias (qualquer rodada). Nunca leva caminho local, conta ou sessão. ≤ 60 KB.
  // destino: batch.destino (a rota de upload grava o destName que a interface manda, 'Meu Drive' na raiz; download =
  // nome da pasta de destino; comparação = pasta do Drive/local) ou o nome da pasta do arquivo baixado.
new AcompanharCelular({ manager, cloud, settings, ativoMs = 10 s, ociosoMs = 90 s, eventoMs = 1,5 s, minGapMs = 2 s,
                        maxEsperaMs = 5 min, pausaLongaMs = 30 min, timeoutMs, fimTimeoutMs = 2,5 s, log, now })
start(); close({ final }); agora(); retrato({ fechado })
```
- **Rodada:** abre quando algo fica ativo (ou termina entre dois retratos) depois de tudo parado; `inicio` = última vez
  em que viu tudo parado (logo ao abrir o app, o `createdAt` do lote em andamento). Tudo parado → a rodada fica
  "encerrada" e continua aparecendo (`concluido`/`erro`/`pausado`) até a próxima. O site avisa uma vez por rodada+estado.
- **Ritmo:** mudança de status (começou, terminou, falhou, pausou) → envio em 1,5 s (junta os que acontecem juntos;
  nunca menos de 2 s entre envios); andando, a cada 10 s; parado, sinal de vida a cada 90 s (o celular considera
  ligado até 2 min). Um envio por vez.
- **Falhas:** nunca lançam nem tocam na fila; recuo crescente até 5 min; 400/403/404/413 → 30 min sem tentar. Sessão
  revogada (401) = a `CloudAuth` sai da conta e o envio para até entrar de novo (evento `status`).
- **Ajuste desligado** com a conta ativa → `DELETE /api/dispositivos/status` (o retrato some do site) e nada mais vai.
- **Fechar o app** (`startApp().shutdown`): se já mandou algo, um último retrato com `fechado: true` (até 2,5 s).

### media/raw-thumb.js — miniatura de .braw

O Drive não gera miniatura de Blackmagic RAW; a API aceita uma nossa em `contentHints.thumbnail`, que vale no Drive web,
no app do Drive e no SOBEDESCE. Quando um envio de `.braw` (ou `.r3d`, sem diferenciar maiúsculas) **termina bem**,
o motor grava um frame como miniatura. Ajuste `brawThumbnails` (padrão ligado; Ajustes → Arquivos).

```js
isRawThumbCandidate(name): boolean                 // RAW_THUMB_EXTS = ['.braw', '.r3d']
async extrairFrame(path, { largura = 960, maxBytes = 1,5 MB, timeoutMs = 90 s, signal, extractors?, log? })
  : Buffer|null                                    // JPEG (PNG se não houver conversão e couber). NUNCA lança:
                                                   // null + log(motivo curto). Tempo limite vale para tudo (mata o processo).
async detectExtractor(): { supported, found, via: 'helper'|'quicklook'|'shell'|null, downloadUrl }   // para os Ajustes
class RawThumbnailer { prepare(record), attach(record, drive): Promise<boolean>, status(), idle(), close() }
```
Extratores (trocáveis; `extractors` aceita qualquer `{ id, label, extract(file, { width, maxBytes, deadline, signal, tmp }) }`):
1. **Ajudante nativo** `sobedesce-raw-frame` (se existir em `SOBEDESCE_RAW_HELPER` ou `<resources>/raw-frame/`):
   `--input <braw> --output <jpg> --width <px> --max-bytes <n>` → 0 = imagem gravada, 2 = "não dá" (null), outro = falha.
   Vem no instalador quando o CI tem o cadastro do SDK (ver abaixo); também gera o proxy de .braw (media/braw.js).
2. **Mac**: `qlmanage -t -s 1280 -o <tmp> <arquivo>` (usa a extensão de miniatura registrada para o tipo) e
   `sips -s format jpeg -s formatOptions 80 -Z 1280` para JPEG; se não couber em 1,5 MB, qualidade 65 e depois 60 a 60 %
   da largura. Sem `sips`, manda o PNG se couber.
3. **Windows**: `powershell.exe -EncodedCommand` com C# em `Add-Type` (compila na memória, nada instalado):
   `SHCreateItemFromParsingName` → `IShellItemImageFactory.GetImage(1280, SIIGBF_THUMBNAILONLY|SIIGBF_BIGGERSIZEOK)` →
   JPEG (82/68 %, depois 60 %/40 % do tamanho) até caber. THUMBNAILONLY: sem manipulador de miniatura, sai 2 (null),
   nunca o ícone do tipo. Caminhos entram por variável de ambiente (nada do nome do arquivo no texto do script).

Fluxo no `TransferManager` (opção `thumbnailer`, `null` desliga): ao **começar** um envio candidato, `prepare(record)`
começa a extração em paralelo (no máximo 2 ao mesmo tempo; cache por caminho+tamanho+mtime); ao **terminar** com
`completed` e `target.fileId`, `attach(record, drive)` espera o frame e chama `drive.setThumbnail` **em segundo plano**:
o status da transferência já é 'completed' e nunca muda por causa da miniatura. Gravou → `record.thumbnail = true`.
Falha (sem extrator, tempo esgotado, imagem grande, Drive recusou) = só uma linha no log. Três falhas seguidas do
extrator → 10 min sem tentar. O app fechar entre o fim do envio e a gravação perde a miniatura (melhor esforço).
`GET /api/raw-thumbs` devolve `status()` para os Ajustes ("Não encontramos o Blackmagic RAW neste computador" + link
para `blackmagicdesign.com/products/blackmagicraw`). A detecção procura o Blackmagic RAW/DaVinci Resolve nas pastas
padrão (Mac: `/Applications/Blackmagic RAW`, `/Applications/DaVinci Resolve`; Windows: `Program Files\Blackmagic Design\…`)
e, no Windows, o manipulador de miniatura de `.braw` no registro (`ShellEx\{e357fccd-…}`).

No Mac, a detecção também aceita uma extensão de Quick Look de terceiros que abre RAW: algum item com
"Calibrated", "BRAW" ou "Blackmagic RAW" no nome em `/Library/QuickLook`, `~/Library/QuickLook`, `/Applications` ou
`~/Applications` (só olha nomes).

**"Gerar miniaturas" para o que já está no Drive** (`media/raw-thumb-lote.js`, botão na barra da tela Drive quando a
pasta tem .braw/.r3d). Nada sobe de novo:
1. Lista os RAW da pasta do Drive (subpastas com `recursive`, padrão ligado; `walk`/`listChildren` com `media: true`
   para trazer `hasThumbnail`, a mesma regra da prévia: `hasThumbnail && thumbnailLink`). Lixeira e atalhos ficam de
   fora. Quem já tem miniatura é pulado, a não ser com `refazer`.
2. Varre a pasta do computador ao mesmo tempo (`indexLocalRaw`): só guarda .braw/.r3d; pula ocultas (`.`), `$…`,
   `System Volume Information`, `node_modules` e AppleDouble (`._`); não segue links simbólicos; pasta já vista
   (dev+inode) não entra de novo; tetos `LOTE_LIMITS` (24 níveis, 400 mil itens) → `localTruncated` no resumo.
3. Par = nome igual sem diferenciar maiúsculas, NFC/NFD iguais (`nameKey`) **e** tamanho igual. Vários com o mesmo
   nome: o primeiro com o mesmo tamanho. Nome igual com tamanho diferente = "tamanho diferente" (pode ser outra tomada).
4. Frame por `RawThumbnailer.frameFor(file, { signal })`: a mesma fila dos envios (2 extrações por vez), mesmo tempo
   limite e teto de 1,5 MB, sem cache, sem a pausa depois de falhas e sem olhar `brawThumbnails` (foi pedido). Depois
   `drive.setThumbnail`. Falha de um arquivo (sem frame, imagem inválida, Drive recusou/sem permissão) entra em
   `falhas` com o motivo e o lote segue; cancelar (AbortSignal) para tudo.
Resumo/progresso: `{ phase: drive|local|gerar|fim, raw, jaTinham, total, aGerar, feitos, semLocal, tamanhoDiferente,
falhou, localFiles, localTruncated, current, falhas[], semLocalNomes[], tamanhoNomes[], feitosIds[] }` (listas com
até 200 nomes). No servidor (`RawThumbJobs` em `routes.js`) roda **um lote por vez** (outro pedido = 409), o progresso
vai pelo SSE `rawthumbs` (no máximo 4×/s) e o último lote fica em `/api/state` (`rawThumbs`). Ao terminar, o servidor
esquece os links de miniatura desses arquivos (`media.forget`) e a interface muda a versão das URLs (`bustThumbs`),
então nenhum cache devolve a imagem antiga. A pasta escolhida fica no ajuste `rawThumbLocalDir`.

Confiabilidade conhecida (pesquisa de 2026-10):
- **Mac**: o macOS 15 (Sequoia) deixou de carregar plug-ins `.qlgenerator`; só extensões de app (appex) geram miniatura.
  Há relatos no fórum da Blackmagic de miniaturas de BRAW sumindo no Finder desde o Sequoia. Onde a extensão da
  Blackmagic não funciona, o Calibrated QuickLook (grátis, junto do Tin Man) gera miniatura de BRAW/R3D e o
  `qlmanage` passa a funcionar sozinho. Se o Quick Look não tiver nada, o `.braw` só fica sem miniatura.
- **Windows**: o manipulador de miniaturas do Blackmagic RAW Player teve regressões (ex.: 1.7 deixou de registrar a
  DLL; relatos ainda em 2025). Mesma regra: sem miniatura do Explorer, sem miniatura no Drive, sem erro.
- **ffmpeg não decodifica BRAW** (nem o 6.x nem o master de 2026: só ProRes RAW entrou; o decodificador BRAW ficou em patch).

O ajudante nativo (`native/raw-frame/`, detalhes no README de lá) vem no app quando o CI tem o segredo
`BRAW_SDK_CADASTRO`: `scripts/raw-frame-build.mjs` baixa o Blackmagic RAW SDK (cadastro + aceite dos termos, o mesmo
pedido do site da Blackmagic), compila (Mac universal; Windows x64 e arm64), copia a biblioteca da Blackmagic para
`raw-frame/BlackmagicRawAPI/` (a licença deixa redistribuir as "API Libraries" junto do app, não os headers: o SDK nunca
entra no repositório) e testa no `sample.braw` do SDK. Sem a biblioteca ao lado, o ajudante tenta a do Blackmagic RAW ou
do DaVinci Resolve instalados. O teste de fumaça roda `--check` no app empacotado.

### media/previa*.js — prévia leve dos vídeos

O Drive toca vídeo pesado fluido porque usa uma cópia leve própria; a API só entrega o original. O app gera a sua:
**H.264 High 8 bits 4:2:0, lado maior ≤ 1280 (720p, como a reprodução do Drive; pares, pixels quadrados), ≈ 2,5 Mbit/s VBR (teto 3,5; libx264 CRF 24 com teto 3), AAC 128k estéreo (ou
sem áudio), `+faststart`, GOP 60, rotação aplicada na imagem**, gravada em `Proxy/<nome-base>.mp4` ao lado do original
(reaproveita uma subpasta `Proxy`/`Proxies` que já exista) com `appProperties { sobedesce: 'previa', original: <id> }`.
O original nunca é tocado. Na interface a cópia se chama **proxy** ("Proxy (cópia leve 720p)"). Ajuste `proxyAoEnviar`
(`'sempre'` padrão | `'perguntar'` | `'nunca'`; o antigo `previaLeve` é migrado no `Settings.load`: true → sempre, false →
nunca); `previaLocalDir` lembra a pasta do lote.

Escolha por envio e por arquivo: `record.proxy` (boolean). `POST /api/transfers/upload { proxy }` grava em todos os
registros do envio; sem ela vale o ajuste na hora de gerar (só `'nunca'` desliga — celular e Comparar não perguntam). A
interface manda `proxy` sempre: no seletor de pasta do **Enviar** (`DrivePicker proxyChoice`) a chave aparece marcada pelo
ajuste; em `'perguntar'`, soltar arquivos ou "Enviar para esta pasta" abre a janela `envio` (components/previa.js).
`TransferManager.setProxy(ids, on)` (`POST /api/transfers/proxy`): na fila/subindo só muda a escolha; envio concluído +
`on` → `enqueue(..., { forcar: true })` (gera mesmo se for leve); `!on` → `cancel`. Só vídeos contam (`elegivel`).

```js
// media/previa.js
isVideoName(name), isRawName(name), previaName(name) /* A001.MOV → A001.mp4 */, isProxyName(cand, name)
parseProbe(stderrDoFfmpegI): { durationS, bitrate, video: { codec, profile, pixFmt, bits, width, height, bitrate, sar }|null, audio, rotation }
precisaPrevia(info|null, { name, size }): { gerar, motivo }
  // gera: > 20 Mbit/s, codec ≠ H.264 8 bits 4:2:0 (ProRes, DNx, HEVC 10 bits…), > 1920 px, contêiner ≠ mp4/m4v/mov.
  // não gera: H.264 ≤ 1080p com < 50 MB, RAW (.braw/.r3d/.ari…), sem vídeo. info null (só avconvert): .mov/.mp4/.m4v ≥ 50 MB.
  // .braw: outro caminho (gerarPreviaBraw → media/braw.js), só com motor.braw.ok.
encoderArgs(enc), videoFilter(info, enc), argsTranscode({ input, output, encoder, info, hwDecode }), argsEncoderTest(enc)
plano(motor, platform): [{ encoder, hwDecode }]   // Mac: VT + decodificação no chip → VT → libx264; Windows: hw → libx264
ffmpegCandidates({ env, platform, arch, resourcesPath, appRoot }): [{ path, origem: 'env'|'app'|'sistema' }]
  // SOBEDESCE_FFMPEG → <Resources>/ffmpeg/ffmpeg(.exe) (também <app>/../ffmpeg) → build/ffmpeg/<os>-<arch>/ → Homebrew → PATH
async detectarMotor(): { via: 'ffmpeg'|'avconvert'|null, ffmpeg: { path, versao, origem }, encoder: { nome, hardware },
                         encoders, avconvert, braw: { path, ok, motivo }|null, label, aviso, testados }
  // `-encoders` + teste de 1 quadro (lavfi, os mesmos parâmetros) para cada codificador de hardware da plataforma
  // (darwin: h264_videotoolbox; win32: h264_nvenc, h264_qsv, h264_amf, h264_mf); senão libx264. Mac sem ffmpeg: /usr/bin/avconvert.
async gerarPrevia(file, { motor, name, size, forcar, signal, onProgress(fase, frac), tmpRoot, log })
  : { estado: 'pronta', path, size, encoder, motivo, limpar() } | { estado: 'dispensada', motivo }   // lança PreviaError/AbortError
runTool(cmd, args, { signal, timeoutMs, stallMs, onStdout, lowPriority })   // sem shell; SIGKILL no abort/tempo/travou
podeTerProxy(name, motor)   // vídeo comum, ou .braw com motor.braw.ok (fila, lote e rota usam isto)
```
**Proxy de Blackmagic RAW** (`media/braw.js`): o ffmpeg não decodifica BRAW, então `sobedesce-raw-frame --frames` (o
mesmo ajudante da miniatura, `native/raw-frame/`) manda os frames em RGBA 8 bits, Rec.709 (gama e gamut, o visual do
proxy gravado pela câmera), na menor escala do SDK que ainda dá 1280 px, por um cano para o ffmpeg
(`-f rawvideo -pix_fmt rgba -s WxH -framerate N/D -i pipe:0`), e o áudio vem do próprio `.braw` (PCM dentro de um
QuickTime: `-i <braw> -map 1:a:0?`). RGB → YUV em BT.709 (`out_color_matrix`), etiquetas de cor BT.709, `-shortest`.
`--info` diz antes o tamanho e a taxa (`fracaoFps`: 23,976 → 24000/1001). `detectarMotor` acrescenta
`braw: { path, ok, motivo } | null` (`--check`). Ajudante que falha no meio mata o ffmpeg (nunca sobra cópia pela metade);
cancelar mata os dois; tempo limite é o dobro do normal. Sem decodificador: `dispensada` com o motivo, e a fila nem pega
o envio (`elegivel`). Medido aqui (Linux, 4 núcleos, CPU): clipe de 3 s 6K/12K → proxy em 11–14 s.
Regras do conversor: `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` (nice 10 / BELOW_NORMAL); tempo limite 10 min + 8× a
duração (6 h sem duração); sem saída por 5 min = travou; progresso por `-progress pipe:1` (`out_time_us`). Falha de uma
tentativa passa para a próxima do `plano` (tempo esgotado/travou não). Temporário em `os.tmpdir()/sobedesce-previa-*`,
apagado sempre (falha, cancelamento ou `limpar()` depois de subir). Sem espaço livre (~1,5× a cópia + 200 MB) ou cópia
≥ 90% do original → dispensada.

`GeradorPrevias` (media/previa-fila.js; opção `previas` do TransferManager, `null` desliga):
- `enqueue(record, drive)` quando um envio de vídeo termina como `completed` **ou** `skipped` (reenviar a pasta gera as
  que faltam). `record.previa = { estado: 'fila'|'analisando'|'gerando'|'enviando'|'pausada'|'pronta'|'dispensada'|
  'falhou'|'cancelada', frac?, motivo?, fileId?, size?, encoder?, at }` vai para `queue.json`; pendentes voltam à fila ao
  reabrir. O status da transferência nunca muda por causa da prévia.
- Antes de converter: arquivo local igual ao enviado (tamanho/mtime) e `procurarProxy` (mesmo nome-base .mp4/.mov/.m4v na
  pasta ou em Proxy/Proxies; o próprio original não conta) → se achar, `dispensada`.
- Sobe com o `UploadTask` normal (limitador de banda dos envios; `uploadConflict: 'rename'`, sem MD5); `target.appProperties`
  vai nos metadados da sessão retomável.
- `pause()`/`resume()` seguem o "pausar/retomar tudo" do manager; `cancel(ids)` é o "Pular" da linha; `close()` no
  encerramento deixa o estado como `fila`. Uma conversão por vez no app inteiro (`gerarESubir` do lote usa a mesma vaga).
- `init()` (chamado por `startApp`): verificação do conversor, uma linha no log (`[motor] prévia leve: ffmpeg 9.0.2 · h264_videotoolbox`).
- `baixarOriginal(drive, item, { signal, onFase })`: "Baixar do Drive para gerar". Confere o espaço livre (original + 1 GB
  de folga; senão erro "sem espaço para baixar o original (precisa de X, livre Y)" antes de qualquer byte), baixa com o
  `DownloadTask` normal (segmentado, conexões refeitas, limitador de downloads, sem MD5) para
  `os.tmpdir()/sobedesce-original-*/` e devolve `{ path, limpar() }`; falha ou cancelamento apagam o temporário.

"Gerar prévias" (media/previa-lote.js, botão na barra da tela Drive quando a pasta tem vídeo): igual ao "Gerar
miniaturas" — lista os vídeos (fora das pastas Proxy e das nossas cópias) e os proxies existentes; varre o computador
(`indexLocalRaw` com `accept: isVideoName`); par por nome + tamanho; `.mp4` pequeno até 1080p pelo Drive conta como leve.
`refazer` substitui só as cópias marcadas (nova versão do mesmo arquivo); proxy de câmera nunca. Opções novas: `somente`
(ids: "Gerar proxy" de um vídeo, ou os que faltaram), `forcar` (gera mesmo se for leve), `dicas` (fileId → caminho local
dos envios da fila; vale com o mesmo tamanho; com elas `localDir` é opcional) e `baixar` (sem original no computador:
`baixarOriginal`, gera e apaga). Resumo: `{ phase, videos, jaTinham, jaLeves, total, aGerar, feitos, semLocal,
semLocalBytes, semLocalIds[], baixados, tamanhoDiferente, falhou, localFiles, localTruncated, current, fase ('analisando'|
'baixando'|'gerando'|'enviando'), frac, falhas[], semLocalNomes[], tamanhoNomes[], feitosIds[] }`. Um lote por vez (409),
SSE `previas`. Na tela Drive: "Gerar proxies da pasta" (barra) e "Gerar proxy" (seleção de um vídeo; `GET
/api/previas/arquivo` diz se a fila conhece o original, se já tem proxy e o espaço livre). O resumo com `semLocal` oferece
"Baixar do Drive para gerar" (confirma o tamanho e o espaço livre antes). Pedido pelo celular: `src/engine/pedidos-proxy.js` pega os
pedidos da conta SOBEDESCE e gera do mesmo jeito (docs/CONTAS.md §11). Selo "Proxy" na lista/grade (`useComProxy`:
mesmo nome-base na pasta ou dentro da subpasta Proxy/Proxies listada, uma consulta por subpasta).

Prévia (as três): vídeo com mais de 30 MB (qualquer codec) procura a cópia leve antes de tocar e toca ela, com
**Proxy | Original** no canto (troca no mesmo ponto). Sem cópia, as regras de
antes (proxy para o que não toca, aviso de vídeo pesado). Baixar baixa sempre o original. `appProperties` só é visível
para o mesmo cliente OAuth que gravou (com um Drive "só neste computador" o site e o celular não sabem que a cópia é
nossa; ela toca igual) — por isso a interface chama tudo de "Proxy" e só a nota embaixo do player muda.

Empacotamento: `scripts/ffmpeg-baixar.mjs` (CI, job `app`) baixa FFmpeg 9.0.2 (martin-riedl.de, arm64 e x64) e 6.1.1
(gyan.dev via ffmpeg-static, win x64) para `build/ffmpeg/<mac|win>-<arch>/` e confere o SHA-256; o `electron-builder.yml`
copia `build/ffmpeg/${os}-${arch}` para `<Resources>/ffmpeg` (fora de app/) e `build/ffmpeg-licencas` (GPL v3, LEIAME
com as fontes). No Mac universal o `@electron/universal` junta os dois ffmpeg com `lipo` (por isso cada pasta só tem o
executável). Windows arm64 sai sem ffmpeg próprio (usa o do sistema, se houver).

### media/quadros.js — hover scrub (ver o take sem abrir)

Passar o cursor na miniatura (app do computador e o site do celular no navegador) ou **segurar o dedo ~0,3 s e
arrastar** (celular) corre o take, como no DaVinci. A imagem vem de uma **tira de quadros**: um JPEG só com 64 quadros
em grade 8 × 8 (lado maior de 240 px por quadro; clipe curto: ~4 quadros por segundo, em linhas cheias de 8), ≈ 150–300
KB, feito pelo ffmpeg a partir do **proxy** (decodifica rápido; acima de 5 min, só os quadros-chave, `-skip_frame nokey`).
```js
gerarQuadros(motor, file, { dir, signal }): { path, size, grade: { n, cols, w, h } }   // lança com motivo curto
celula(w, h), argsQuadros({ input, output, durationS, cel, n, cols }), gradeTexto(g) / lerGrade(s), quadrosName(name)
```
Onde fica: `Proxy/<nome-base>.quadros.jpg` ao lado do proxy, com `appProperties { sobedesce: 'quadros', original, proxy }`.
O **original** ganha `appProperties { quadros: <id da tira>, quadrosGrade: 'n.cols.w.h' }` (`drive.setAppProperties`,
mescla com as outras marcas): a grade acha a tira sem consulta nenhuma. Quando é feita:
- **Depois de cada proxy** (`GeradorPrevias.#gerarESubir` → `#quadros`, a partir do proxy local antes de apagar o
  temporário). Refazer o proxy troca a mesma tira (`replaceFileId`). Falha = uma linha no log; o proxy fica. Sem ffmpeg
  (Mac só com avconvert), sem tira.
- **"Gerar proxies da pasta"** (`previa-lote.js`): quem já tem proxy (do app ou da câmera, inclusive BRAW/R3D com o
  proxy da câmera) e ainda não tem tira entra numa segunda volta (`gerador.quadrosDoProxy`, na mesma vaga da fila):
  baixa **só o proxy**, gera, sobe ao lado dele e aponta o original. Resumo: `quadrosAGerar`, `quadros`, `quadrosFalhou`.

A tira não aparece nas listas (`driveView` no computador, `listPage` no celular) e o Comparar trata como peça do app
(não é "só no Drive"). Interface: `public/components/scrub.js` (grade do Drive; some o botão de prévia enquanto corre) e
`web/public/app/components/scrub.js` (grade do celular; a imagem vem pelo `/app/stream/<id>` do service worker;
`touchmove` não passivo segura a rolagem só com o toque ligado; soltar não abre o arquivo; mexer o dedo antes de ligar é
rolagem). Classes `.hscrub*` (`.scrub` já é a linha do tempo do player).

### referencias/ — Referências (contrato com o site em `docs/REFERENCIAS.md`, frente web)

Vídeos e fotos de referência salvos em `SOBEDESCE Referências/<Coleção>/` no Drive de uma conta SOBEDESCE (`nuvem:<id>`).
O site guarda coleções e a fila do celular; o computador é quem baixa (yt-dlp) e sobe.

```
salvar(link) ─▶ fila local (2 downloads por vez) ─▶ yt-dlp numa pasta só dele (<dados>/referencias/tmp/<job>)
            ─▶ arquivo final em <dados>/referencias/envios/<job>/ ─▶ registro de upload normal no TransferManager
               (Transferências, retomável; `conflict: 'skip'`, `target.meta` = descrição + appProperties na criação,
                `referencia: { jobId }`, lote `quiet`) ─▶ miniatura do yt-dlp por contentHints ─▶ "Salvo em <Coleção>"
fila do celular: a cada 30 s (e no foco da tela) GET fila?status=pendente → POST pegar (409 = outro computador)
               → mesmo caminho → PATCH pronto {driveFileId} | erro {erro}; PATCH baixando a cada 5 min (sinal de vida)
```

- `plataformas.js`: `detectar(url) → { plataforma, nome, salvavel }` (tabela de padrões de reel/post/watch/shorts/
  video/pin/status por site), `dominiosDeCookies(url)` (só os do site do vídeo), `limparUrl` (tira rastreio). Usado também
  pelo processo principal do Electron (botão "Salvar referência" e menu de contexto).
- `metadados.js`: nome `<Autor> - <Título curto> (<Plataforma>).<ext>` (sem `\/:*?"<>|`, até 120 caracteres; repetido =
  `uniqueName` do envio), `appProperties` (`sobedesce=referencia`, `plataforma`, `autor`, `titulo`, `fonte`, `fila`; cada
  chave + valor ≤ 124 bytes UTF-8, cortado sem partir caractere; `fonte` perde a query antes de ser cortada) e a descrição
  do §4 do contrato (1ª linha = link completo, `Título/Autor/Plataforma/Salvo em`, linha em branco, legenda, `Nota: …`).
  `lerReferencia(item)` lê de volta para a tela.
- `cookies.js`: cookies do Electron → Netscape (`#HttpOnly_`, hostOnly = FALSE), arquivo `cookies.txt` 0600 numa pasta 0700
  aberto com `wx`, apagado assim que o yt-dlp termina (sucesso, erro, cancelamento).
- `ytdlp.js`: `montarArgs` (`--ignore-config --no-playlist --newline`, formato
  `bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/b`
  com ffmpeg (`--ffmpeg-location`, `--merge-output-format mp4`, `--convert-thumbnails jpg`); sem ffmpeg só progressivos
  `b[height<=1080][ext=mp4]/b[ext=mp4]/…`; `--write-info-json --write-thumbnail`, `-P <pasta>`, `--max-filesize 4G`,
  `--progress-template "download:SDPROG …"`, `--cookies`, `--js-runtimes node:<Node do app>` e o link depois de `--`).
  O YouTube exige um interpretador de JavaScript (`jsRuntimePadrao` em `binarios.js`): no app de desktop, o QuickJS-ng que
  vai junto (`<Resources>/quickjs/qjs`, `--js-runtimes quickjs:<caminho>`; o fusível RunAsNode desligado não deixa mais
  usar o próprio Electron); no `npm start`, o Node. Sem o QuickJS, o yt-dlp procura um deno/node do sistema sozinho. `Progresso` soma as partes (vídeo + áudio) e marca "juntando"; `classificarErro` transforma o
  stderr em frase curta (login, privado/removido, sem vídeo, não suportado, limite, recusado, rede, região, formato…).
  `baixarVideo` mata a árvore inteira (grupo de processos no Mac/Linux, `taskkill /T` no Windows) em cancelamento, tempo
  limite (30 min) e travamento (3 min sem saída).
- `binarios.js`: onde está o yt-dlp (`SOBEDESCE_YTDLP`, `<Resources>/yt-dlp/` + `versao.txt`, `build/yt-dlp/<mac|win-x64…>`,
  Homebrew/PATH) e o ffmpeg (`ffmpegCandidates` da prévia leve).
- `ytdlp-update.js` (`YtdlpUpdater`): ao ligar as Referências e no máximo uma vez por dia, descobre a última versão pelo
  redirecionamento de `github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS` (sem a API e o limite dela), lê o
  `SHA2-256SUMS` daquele Release, baixa o arquivo da máquina (`yt-dlp_macos` universal, `yt-dlp.exe`, `yt-dlp_arm64.exe`)
  para `<dados>/yt-dlp/<versão>/`, confere o SHA-256 (diferente = apaga, nunca roda), só então testa `--version` e grava
  `estado.json`. `resolver()` prefere o atualizado quando é mais novo que o do app e reconfere o hash dele a cada abertura
  (arquivo trocado no disco = apagado, volta o do app). Falha de rede = tenta na próxima abertura.
- `api.js` (`ReferenciasApi`): as rotas do site com o Bearer do computador (`CloudAuth.request`), erros com `codigo`
  (`sem_sessao`, `plano` — 403 com `motivo: 'plano'` —, `nao_encontrada`, `ocupado`, `entrada`, `rede`, `servidor`),
  repetição em rede/5xx/429 só no que é idempotente (GET, PATCH, DELETE, pegar). `link`: `true/false` viram `ligar/desligar`.
- `formatos.js` ("Baixar como…", contrato em docs/REFERENCIAS.md §7): a tabela (`original`, `mp4`, `mp4-1080`,
  `mp4-720`, `mp3-320`, `wav`, `m4a`, `jpg`), `nomeConvertido` ("<original> (MP3 320).mp3", até 120 caracteres),
  `argsFormato` (linha do ffmpeg de cada formato: MP3 `libmp3lame -b:a 320k` CBR; WAV `pcm_s16le` 48 kHz; M4A copia o
  AAC; MP4 copia H.264 + AAC que já cabe, senão `libx264 -crf 18` ou o codificador da máquina, lado menor ≤ 1080/720)
  e `converterFormato` (sonda com `ffmpeg -i`, confere o codificador, converte com andamento, tenta o próximo
  codificador de vídeo, frases curtas em `FormatoError`).
- `pedidos-formato.js` (`PedidosFormato`): pedidos `tipo: formato` do celular (`/api/proxies/pedidos`), um por vez,
  pelo `exportar` do serviço; sinal de vida a cada 5 min; sem ffmpeg não pega; fechar o app devolve o pedido.
- `service.js` (`ReferenciasService`): estado em `<dados>/referencias.json` (trabalhos ativos + os 80 últimos).
  Fases `na_fila → baixando → enviando → concluindo → pronto | erro | cancelado`. Ao abrir: `tmp/` é apagada, download
  pela metade recomeça, envio continua (o registro está na fila de transferências). Cancelar para o yt-dlp ou o envio e
  apaga temporários; item da fila do celular cancelado vira erro "Cancelado no computador". `status()` vai pelo SSE
  `referencias`: `{ ativo, motivo: null|'sem_conta'|'plano', navegador, trabalhos, versoes, ytdlp }` (`versoes[colecao]`
  muda quando algo termina: a tela relê a coleção). 403 plano pausa a fila por 1 h. Cookies: `setCookieProvider(fn)`
  (o app de desktop pede ao processo principal; sem ele, o yt-dlp roda sem login). Trabalhos `tipo: 'formato'` na mesma
  fila: `salvar({ formatos })` cria um por formato com o vídeo baixado como fonte (vínculo em
  `<dados>/referencias/formatos/<id>/`); `exportar({ colecaoId|accountId, fileId, formato, destino, destDir })` baixa o
  original do Drive (`previas.baixarOriginal`, guardado 10 min, no máximo 3) para `<dados>/referencias/originais/`,
  converte em `tmp/<id>`, copia para a pasta do computador (`.sobedesce-part` → nome final) e/ou sobe pela fila de
  envios ao lado do original (`appProperties.sobedesce = 'formato'`). `esperar(id)` resolve no fim (evento `fim`).

Rotas locais (`src/server/referencias.js`, entrada validada; erros do site viram 401/403/404/409/502 com a frase dele):

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | `/api/referencias` | | `{ referencias: status }` |
| GET | `/api/referencias/detectar` | `url` | `{ url (limpa) \| null, plataforma, nome, salvavel }` |
| GET / POST | `/api/referencias/colecoes` | `forcar=1` / `{ nome, contaId? }` | `{ raiz, colecoes }` / `{ colecao }` |
| PATCH / DELETE | `/api/referencias/colecoes/:id` | `{ nome?, link?: true\|false\|'ligar'\|'desligar'\|'trocar' }` / `{ apagarNoDrive? }` | `{ colecao }` / `{}` |
| GET | `/api/referencias/colecoes/:id/itens` | `forcar=1`, `fila=0` | `{ colecao, accountId, itens: DriveItem + { createdTime, referencia }, pendentes }` |
| POST | `/api/referencias/salvar` | `{ url, colecaoId, nota?, origem?, formatos? }` | `{ trabalho }` |
| POST | `/api/referencias/salvar-imagem` | `{ imagemUrl (https ou data:image), paginaUrl?, titulo?, colecaoId, nota?, formatos? }` | `{ trabalho }` |
| POST | `/api/referencias/exportar` | `{ colecaoId, fileId, formato, destino: 'computador'\|'drive'\|'ambos', destDir? (absoluta) }` | `{ trabalho }` |
| GET | `/api/referencias/conversor` | | `{ conversor: { ok, mp3, h264, aviso, formatos } }` |
| POST / DELETE | `/api/referencias/trabalhos/:id/cancelar`, `…/tentar` / `/api/referencias/trabalhos/:id` | | `{}` / `{ trabalho }` |
| POST | `/api/referencias/fila/consultar` · `/api/referencias/fila/:id/tentar` · DELETE `/api/referencias/fila/:id` | | `{}` |
| POST | `/api/referencias/ytdlp/verificar` | | `{ ytdlp }` |

Interface: tela **Referências** (`public/components/referencias.js`, rota `#/referencias[/<colecao>]`), janela/painel
"Salvar referência" (`referencias-salvar.js`, o mesmo nos dois lugares, com "Também salvar como"), o menu
"Baixar como…" (`referencias-formato.js`: botão no cartão, botão direito e na prévia; Pílulas de destino e os formatos)
e o aviso de primeiro uso (ajuste `referenciasAvisoVisto`). A prévia é a `DrivePreview` da tela Drive com o bloco `extra` (origem).

**Navegador de referências** (`desktop/navegador.js`, só no app): `BaseWindow` com duas `WebContentsView`:
- **barra** = `${motor}/navegador.html` (sessão padrão, preload `preload-navegador.cjs` com `navegador.{ir, acao, painel,
  estado, aoEstado, aoSalvar, abrirFora}`); ocupa a janela toda e a página fica por cima, abaixo da barra (56 px) e à
  esquerda do painel (380 px). Canais `navegador:*` só respondem à própria barra, com `trustedSender`.
- **página** = sessão `persist:navegador` (cookies do Instagram etc. ficam só ali), `sandbox`, `contextIsolation`, sem
  preload, sem Node. `webRequest.onBeforeRequest` cancela qualquer requisição para loopback (`127.0.0.0/8`, `::1`,
  `localhost`, `0.0.0.0`, formas numéricas) e esquemas que não são http(s)/ws(s)/data/blob: a página nunca alcança o motor
  nem a recepção do celular. Navegação só http(s) fora de loopback (`will-navigate`, `will-redirect`, quadros), pop-ups
  abrem na mesma view, downloads cancelados (`will-download`), permissões negadas (só `fullscreen`), `<webview>` negado,
  agente sem "Electron/…". `did-navigate(-in-page)` (SPA) atualiza a barra; `detectar` acende "Salvar referência".
  Menu de contexto: "Salvar imagem como referência" (o motor baixa a imagem com os cookies daquele host e o Referer da
  página), "Salvar link como referência", "Salvar esta página…", copiar, abrir no navegador do sistema.
- Cookies para o yt-dlp: o motor (utilityProcess) manda `{ type: 'cookies-pedido', id, dominios }`; o processo principal
  responde só com os cookies desses domínios (`dominiosValidos`: nomes simples, nada de loopback; até 6), em 5 s ou vazio.
- A janela principal abre o navegador por `window.sobedesce.abrirNavegador(url?)` (canal `sobedesce:abrir-navegador`).

**Empacotamento:** `scripts/ytdlp-baixar.mjs` (CI, antes do `dist:*`) baixa a versão fixa (`VERSAO`, SHA-256 do
`SHA2-256SUMS` daquele Release) para `build/yt-dlp/mac/` (universal) e `build/yt-dlp/win-x64|win-arm64/`, com
`versao.txt`; `electron-builder.yml` põe em `<Resources>/yt-dlp/` (fora do `app/`) por `mac.extraResources` e
`win.extraResources`; no Mac o binário já é universal (o `@electron/universal` pula o lipo; `x64ArchFiles` cobre o caso).
**Licenças:** yt-dlp é Unlicense (domínio público); os executáveis levam Python (PSF) e bibliotecas permissivas.
**Uso:** referência pessoal; baixar de plataformas pode contrariar os termos de uso delas, e a responsabilidade é de quem
salva (o app avisa no primeiro uso e no painel do navegador).

O que só dá para conferir num Mac/Windows de verdade: a janela do navegador (WebContentsView, layout, menu de contexto,
login do Instagram/Google dentro dela), um vídeo do YouTube de ponta a ponta com o QuickJS empacotado (o teste de fumaça do
CI só confere que ele roda; num Linux, o yt-dlp 2026.08.19 resolveu os desafios com o QuickJS-ng 0.17.0 em ~16 s), o
`x64ArchFiles`/universal no `dist:mac`, o `taskkill /T` e a troca do yt-dlp atualizado no Windows (antivírus).

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
| GET | `/api/state` | | `{ app:{name,version,platform}, setup:{configured, clientIdHint}, accounts, cloud, settings, transfers, batches, stats, media, rawThumbs, previas, versao }` |
| POST | `/api/setup/credentials` | `{ json }` ou `{ clientId, clientSecret }` | `{ setup }` |
| GET | `/api/auth/start` | | 302 para o Google (redirect_uri = `http://127.0.0.1:<porta>/oauth/callback`) |
| GET | `/oauth/callback` | `code, state` | página HTML "Conta conectada" que volta para `/` |
| DELETE | `/api/accounts/:id` | | `{ accounts }` (conta `nuvem:` → 400) |
| GET | `/api/cloud` | | `{ cloud: CloudStatus }` |
| POST | `/api/cloud/login` | | `{ cloud }` com `login.codigo` e `login.url` (a interface abre o navegador) |
| POST | `/api/cloud/login/cancel` | | `{ cloud }` |
| POST | `/api/cloud/logout` | | `{ cloud }` |
| POST | `/api/cloud/refresh` | | `{ cloud }` (relê /api/eu) |
| GET | `/api/drive/:acc/about` | | `{ about }` |
| GET | `/api/drive/:acc/drives` | | `{ drives }` |
| GET | `/api/drive/:acc/list` | `folderId` (padrão `root`) | `{ folder, path, items }` |
| GET | `/api/drive/:acc/search` | `q` | `{ items }` |
| GET | `/api/drive/:acc/pastas` | `q`, `escopo` (`root` = Meu Drive, ou o id do drive compartilhado) | `{ items: [{ id, name, driveId, path }] }` (só pastas, até 20; `path` = nomes da raiz até o pai) |
| GET | `/api/drive/:acc/link` | `id`, `rk?` | `{ link: { id, name, isFolder, url, access: 'qualquer'\|'dominio'\|'restrito'\|'desconhecido', domain, canShare, sharedDrive, root, podeLiberar } }` |
| POST | `/api/drive/:acc/link/liberar` | `{ id, rk?, confirmado: true }` | `{ link }`. Cria "qualquer pessoa com o link" (leitor). Sem `confirmado: true` → 400; a tela só manda depois da confirmação "Qualquer pessoa com o link vai poder ver e baixar". Recusa do Workspace/drive compartilhado → 403 com a mensagem |
| POST | `/api/drive/:acc/lixeira/mac` | `{ folderId, ids: [1–50], confirmado: true }` | `{ movidos, pulados, recusados }`. Manda para a lixeira do Drive (files.update `trashed: true`, recuperável por 30 dias) os arquivos de controle do Mac da pasta: `._*` com menos de 4 MB, `.DS_Store` e `Thumbs.db` (`isMacClutter`). A pasta é listada de novo: id que não é filho dela ou não passa na regra vai para `pulados`. Sem `confirmado: true` → 400; a tela manda em lotes de 10 depois da confirmação. Tudo recusado por permissão → 403 com a mensagem (drive compartilhado pede Administrador de conteúdo) |
| POST | `/api/drive/:acc/folders` | `{ parentId, name }` | `{ item }` |
| GET | `/api/drive/:acc/compartilhados` | | `{ items }` ("Compartilhados comigo": pastas e arquivos de outras pessoas; as pastas abrem pelo `/list`, com `path` começando nelas) |
| POST | `/api/drive/:acc/renomear` | `{ id, name }` | `{ item }` (400 nome vazio, com "/" ou maior que 255; 403 sem permissão) |
| POST | `/api/drive/:acc/mover` | `{ ids: [1–50], destId }` | `{ movidos, ja, recusados: [{ id, status, error }] }`. Um de cada vez (`DriveClient.move`). Nada movido e tudo recusado → erro com a mensagem do primeiro (400 pasta para dentro dela mesma, 403 sem permissão, 404) |
| POST | `/api/drive/:acc/tamanho` | `{ folderId, refresh?, auto? }` | `{ tamanho: TamanhoView }` (começa ou devolve a conta guardada; `auto` não recomeça uma parada à mão) |
| GET | `/api/drive/:acc/tamanho` | `ids=a,b,c` (até 200) | `{ tamanhos: { id: TamanhoView\|null } }` (a interface pergunta a cada ~0,7 s; sem pergunta por 20 s a conta é abandonada) |
| DELETE | `/api/drive/:acc/tamanho` | `{ folderId, discard? }` | `{ tamanho }` ("Parar": guarda o parcial; `discard` esquece) |
| POST | `/api/copiar/:acc/ler` | `{ link }` | `{ plano: { planoId, nome, pasta, dono, arquivos, subpastas, bytes, bloqueados, atalhos } }`. Lê o link do Drive (pasta ou arquivo, com `resourcekey`; header `x-goog-drive-resource-keys` em cada pedido) e varre as subpastas (até 5000 arquivos). O plano inteiro fica no servidor. Link que a conta não abre → 400 com a mensagem |
| POST | `/api/copiar/:acc` | `{ planoId, dest: { id, name, path?, driveId? }, localDir? }` | `{ copia }`. Com `localDir` ("Também baixar para uma mídia física"; a pasta precisa existir, senão 400 e nada começa): quando a cópia termina (ou para no meio), o que ela criou no Drive da conta vira downloads na fila de sempre (`planDownloads` com `walked`: as pastas e cópias recém-criadas, sem listar de novo). Baixa da CÓPIA, não do link: o Google entrega o arquivo de outra pessoa por link bem mais devagar (visto em uso real: ~25 KB/s por conexão). `copia.download = { status: aguardando\|na fila\|nada\|erro, destDir, count, bytes, batchId, skipped, error }`. Começa a cópia (uma por vez, 409 se já tem): pasta do link → pasta com o mesmo nome em `dest`, subpastas recriadas, `files.copy` 3 por vez. Sem `canCopy` e atalhos ficam de fora. Drive cheio, limite do dia, sem permissão no destino ou sem internet param com `stopped`. Progresso pelo SSE `copiar` (≤ 4×/s) e em `/api/state.copia` |
| GET | `/api/copiar` | — | `{ copia }` (a cópia atual ou a última: `{ jobId, plano, dest, status: running\|done\|canceled\|error, progress: { done, total, bytesDone, bytesTotal, current, failed[], newFolderId, stopped } }`) |
| DELETE | `/api/copiar/:id` | — | `{ parou }` ("Parar": o que já foi copiado fica) |
| GET | `/api/drive/:acc/proxy` | `id`, `rk?` | `{ proxy: DriveItem\|null }` (proxy de câmera; ver "Miniaturas e prévia") |
| GET | `/api/drive/thumb` | `account, id, k, s?, v?, rk?` | imagem (miniatura; `x-sobedesce-cache: memory\|disk\|google`) |
| GET/HEAD | `/api/drive/stream` | `account, id, k, rk?` + cabeçalho `Range` | bytes do arquivo (200/206/416) |
| GET | `/api/local/roots` | | `{ roots, home, sep }` |
| GET | `/api/local/list` | `path`, `hidden` | `{ path, parent, entries }` |
| POST | `/api/transfers/download` | `{ accountId, items: DriveItem[], destDir?, conflict? }` | `{ batch, count, bytes, skipped }` |
| POST | `/api/transfers/upload` | `{ accountId, paths, destFolderId, driveId?, conflict?, proxy?: boolean, destName? }` | `{ batch, count, bytes, skipped }` (`destName` = nome da pasta do Drive, só para o "Acompanhar pelo celular") |
| POST | `/api/transfers/action` | `{ action: pause|resume|cancel|retry|remove|prioritize, ids?: string[]|'all', batchId? }` | `{ }` |
| POST | `/api/transfers/clear` | | `{ }` |
| GET | `/api/settings` / PATCH `/api/settings` | patch | `{ settings }` |
| GET | `/api/raw-thumbs` | `refresh=1` (refaz a detecção) | `{ rawThumbs: { supported, found, via, enabled, last, downloadUrl } }` |
| POST | `/api/raw-thumbs/lote` | `{ accountId, driveFolderId, localDir, recursive?: true, refazer?: false, folderName? }` | `{ jobId }` (progresso via SSE `rawthumbs`; 400 pasta inválida, 409 já tem um rodando) |
| GET / DELETE | `/api/raw-thumbs/lote/:jobId` | | `{ jobId, status: running|done|canceled|error, progress, error? }` / `{ }` (para o lote) |
| GET | `/api/previas` | `refresh=1` (refaz a detecção) | `{ previas: { enabled, motor: { via, label, aviso, versao, origem, encoder, hardware }, fila, pausada, atual, last } }` |
| POST | `/api/previas/pular` | `{ ids: string[] }` | `{ count }` (pula a prévia leve desses envios) |
| POST | `/api/previas/lote` | `{ accountId, driveFolderId, localDir?, recursive?: true, refazer?: false, somente?: string[], forcar?, baixar?, folderName?, arquivo? }` | `{ jobId }` (SSE `previas`; 400 pasta inválida ou sem pasta/`somente`/`baixar`, 409 já tem um rodando ou sem conversor) |
| GET | `/api/previas/arquivo` | `accountId, id` | `{ arquivo: { id, name, size, parentId }, proxy: { id, name, nosso }\|null, local: caminho\|null, livre }` |
| GET | `/api/previas/espaco` | | `{ livre }` (bytes livres onde os originais baixados ficam) |
| POST | `/api/transfers/proxy` | `{ ids: string[], proxy: boolean }` | `{ count }` (proxy por arquivo; concluído + true = gerar agora) |
| GET / DELETE | `/api/previas/lote/:jobId` | | como o das miniaturas |
| POST | `/api/compare` | `{ accountId, localPath, driveFolderId, mode }` | `{ jobId }` (progresso via SSE) |
| GET | `/api/compare/:jobId` | | `{ status, progress, result?, error? }` |
| POST | `/api/compare/:jobId/upload` | `{ statuses?: ['missing','different'], relDirs?: string[] }` | `{ batch, count, bytes }` |
| POST | `/api/compare/:jobId/download` | `{ relDirs?: string[] }` | `{ batch, count, bytes }` |
| POST | `/api/reveal` | `{ path }` | abre no Finder/Explorer |
| GET | `/api/versao` | | `{ versao: VersionStatus }` |
| POST | `/api/versao/verificar` | | `{ versao }` (pergunta ao site agora; falha não dá erro, vira `falhou: true`) |
| POST | `/api/versao/depois` | `{ build? }` (padrão: o mais novo conhecido) | `{ versao }` (grava `versaoDispensada`; 400 build inválido, 409 nenhuma versão conhecida) |
| POST | `/api/versao/atualizar` | `{ pausar? }` | `{ versao }` (começa o "Atualizar" e volta logo; progresso pelo SSE `versao`. 409 com transferências andando sem `pausar: true`, sem versão nova ou sem Updater; 400 `pausar` não booleano) |
| GET | `/api/events` | | SSE |

SSE (`text/event-stream`, `event:` + `data:` JSON, ping a cada 15 s):
`hello` (= `/api/state`), `transfers` (PublicTransfer[] alterados), `removed` (ids), `batches`,
`stats`, `accounts`, `cloud` (CloudStatus), `settings`, `versao` (VersionStatus), `rawthumbs`, `previas` (lotes), `compare` (`{ jobId, status, progress, error? }`), `toast` (`{ kind, message }`).

### version.js — aviso de versão nova (`VersionChecker extends EventEmitter`)

Descobre que há build mais novo e a interface mostra "Nova versão do SOBEDESCE" (barra lateral e Ajustes →
Atualizações) com **Atualizar** (app empacotado no Mac/Windows: o motor baixa e troca o app; ver `updater.js` abaixo),
**Baixar** (abre `<site>/baixar/mac|windows` no navegador do sistema) e **Depois**.

- **Identidade do build:** `src/build-info.json` `{ build, commit, data }`. No repositório fica `build: 0` (versão de
  desenvolvimento: nunca pergunta nada ao site). O GitHub Actions roda `node scripts/build-info.mjs` antes do `dist:*`
  (build = `github.run_number`, commit curto, data do commit). Na main, cada job de app calcula o SHA-256 do seu
  instalador (`node scripts/sha256.mjs mac|windows dist sha256` → artefato `sha256-<plataforma>`, 1 dia) e, só depois dos
  dois instaladores no Release de teste, o job "Avisar versão nova" junta tudo
  (`node scripts/build-info.mjs versao.json --sha256 sha256`, falha se faltar um) e sobe como `versao.json`.
- **Site:** `GET /baixar/versao` (`web/src/app/baixar/versao/route.ts`, código comum com `/baixar/[plataforma]` em
  `web/src/lib/release.ts`) devolve `{ ok, build, commit, data, mac: '/baixar/mac', windows: '/baixar/windows',
  sha256Mac, sha256Windows }` (cache de 5 min; os `sha256*` são `null` num `versao.json` antigo), ou 503 `{ ok: false }`.
  `mac`/`windows` continuam textos: apps antigos só leem `build`/`commit`/`data`.
- **Motor:** com build > 0, confere ~10 s depois de abrir e a cada 1 h (tempo limite de 15 s; falha = silêncio). A base é
  a mesma da conta SOBEDESCE (`cloud.baseUrl`). "Depois" grava o build em `settings.versaoDispensada`; só um build maior avisa de novo.
  `startApp({ versionOptions })` troca peças nos testes (`buildInfo`, `baseUrl`, `platform`, `fetchJSON`, `firstDelayMs`, `everyMs`).

```
VersionStatus = { atual: { build, commit, data }, ultima: { build, commit, data, sha256: { mac, windows } } | null,
  disponivel (build mais novo, mesmo dispensado), nova (disponível e não dispensado: mostra o aviso), dispensada,
  plataforma: 'mac'|'windows'|null (sem instalador → nunca avisa), baixarUrl, site, verificando, verificadaEm, falhou,
  podeAtualizar (há Updater, ele pode instalar este build e o versao.json trouxe o SHA-256 da plataforma),
  atualizacao: { disponivel, motivo, fase, build, recebido, total, erro, bloqueado } | null }
```

### updater.js — "Atualizar" pelo próprio app (`Updater extends EventEmitter`)

Sem assinatura da Apple/Microsoft, o que trava a instalação é a marca de "veio da internet" que o navegador põe no
arquivo (quarentena do macOS, Mark-of-the-Web do Windows). Arquivo baixado pelo próprio motor não ganha essa marca.

- **Só no app empacotado:** `desktop/main.js` passa `SOBEDESCE_APP_EXE` (`process.execPath`) e `SOBEDESCE_APP_PID` ao motor
  quando `app.isPackaged`; `desktop/engine.js` cria o `handoff` e `startApp({ updaterOptions })` só monta o Updater com
  ele. `npm start`, Linux e build 0 ficam só com o Baixar.
- **Disponível?** Mac: o `.app` (subindo de `process.execPath`) e a pasta dele precisam aceitar gravação; aberto de
  `/Volumes/…` (o `.dmg`) ou de `…/AppTranslocation/…` não dá (`motivo` diz o que fazer). Windows: a pasta do `.exe`.
- **Fases:** `baixando` (`downloadTo`: undici com o proxy do sistema, segue o redirecionamento de `/baixar/<plataforma>?build=N`
  para o GitHub, SHA-256 calculado no caminho, para se ficar 60 s sem dados, limite de 2 GiB) → `conferindo` (hash
  diferente = erro) → `preparando` → `pronto` → `reiniciando` (handoff, no Atualizar agora) | `erro`.
  - Mac: `hdiutil attach -nobrowse -noautoopen -readonly -mountpoint <tmp>`, `ditto` do `.app` para
    `.<Nome>-atualizacao.app` ao lado do atual (mesmo disco: a troca é um `mv`), `hdiutil detach` (com `-force` se
    precisar), `xattr -cr`, e grava `trocar.sh`.
  - Windows: grava `trocar.ps1` (UTF-8 com BOM) para rodar o instalador NSIS com `/S --updated --force-run`.
- **Handoff:** o motor manda `{ type: 'update-handoff', script }` ao processo principal, que confere o caminho
  (`isHandoffScript`: `trocar.sh|ps1` dentro de `<tmp>/sobedesce-atualizacao-*`), roda o script solto
  (`handoffCommand`: `/bin/sh` ou `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File`) e, quando ele
  começou, fecha o app sem perguntar (as transferências pausam no `shutdown` e voltam na próxima abertura).
- **O script** espera o PID do app sair (até 2 min). Mac: renomeia o app para `.<Nome>-antigo.app`, põe o novo no
  lugar, `xattr -cr`, apaga o antigo e `open`; se um `mv` falhar, o antigo volta e é aberto. Windows: roda o instalador
  (espera só ele, não o app que ele abre) e abre `SOBEDESCE.exe` se o instalador não abriu. Falhou → grava
  `atualizacao-falhou.json` na pasta de dados `{ build, motivo }`; na próxima abertura o Updater lê, apaga e mostra o
  motivo, com o Atualizar desligado para aquele build.
- **Sozinho em segundo plano** (`src/version.js`): ao ver um build novo não dispensado, o VersionChecker chama
  `preparar()`, que baixa, confere e prepara e para na fase `pronto`. O aviso mostra o progresso e, no fim,
  **Atualizar agora** (`trocar()`, o handoff). Atualizar no meio do download marca `aplicar` e troca assim que ficar
  pronto. Saiu um build mais novo com outro já pronto: descarta o antigo e baixa o novo.
- **Instalador por build:** o download pede `/baixar/<plataforma>?build=N`. O Release guarda instaladores com o build
  no nome (`SOBEDESCE-0.1.0-b170-mac-universal.dmg`, `scripts/nome-instalador.mjs`, os 3 últimos builds;
  `scripts/limpar-release.mjs`) e o `versao.json` diz o nome de cada um (`arquivoMac`/`arquivoWindows`). Assim o arquivo
  entregue é sempre o do SHA-256 conferido. Antes, o build seguinte trocava o `.dmg` no Release antes do `versao.json`,
  e a lista guardada pelo site apontava para o arquivo apagado ("indisponível": o app baixava a página do site).
  Build que já saiu do Release → 404 (nunca a página).
- **Erros que passam sozinhos** (rede, hash diferente porque a versão ainda está subindo) tentam de novo em 2, 4, 8…
  até 30 min (`deNovo`). **Erros definitivos** (sem SHA-256, `hdiutil`/`ditto` falhou) desligam o Atualizar daquele
  build (`bloqueado`): a interface volta para o Baixar.
- **Transferências:** a interface pergunta ("Há transferências em andamento. Atualizar agora vai pausá-las.") e manda
  `pausar: true`; a rota recusa (409) sem isso se `manager.activeCount()` > 0.
- `updaterOptions` troca as peças nos testes: `platform`, `appExe`, `appPid`, `stateDir`, `tmpRoot`, `handoff`,
  `download`, `run` (hdiutil/ditto/xattr), `canWrite`, `progressMs`.

### Instaladores de uma linha (site)

`web/public/instalar.sh` (`curl -fsSL <site>/instalar.sh | bash`) e `web/public/instalar.ps1`
(`irm <site>/instalar.ps1 | iex`), servidos como `text/plain; charset=utf-8` (`web/next.config.ts`). Mesma ideia do
Updater, pelo Terminal/PowerShell: leem `sha256Mac|sha256Windows` em `/baixar/versao` (sem ele, não instalam), baixam
`/baixar/<plataforma>`, conferem o SHA-256, fecham o app aberto pelo jeito normal (`osascript quit` / `CloseMainWindow`),
e instalam: Mac com `hdiutil` + `ditto` para `/Applications` (troca com volta atrás, `sudo` só se a pasta exigir,
`xattr -cr`, `open`); Windows com o instalador NSIS em `/S --force-run`. O `.sh` roda tudo de uma função `main`
chamada na última linha; o `.ps1` é um bloco `& { … }` sem `exit` (com `iex`, `exit` fecharia a janela). O site
mostra os comandos com botão de copiar (`web/src/components/comando.tsx`) na home (cartões Mac e Windows) e na conta
("No computador"). `SOBEDESCE_SITE` troca o site (teste local).

### Miniaturas e prévia (`src/server/media.js`)

- **Chave de mídia**: `<img>` e `<video>` não mandam cabeçalhos, então `/api/drive/thumb` e `/api/drive/stream` exigem
  `k` = `media.key` de `/api/state` (aleatória a cada abertura do app; só a interface consegue ler o estado). Sem a chave,
  com chave errada ou com `Sec-Fetch-Site: cross-site|same-site` → 403, antes de olhar conta ou arquivo. As respostas
  levam `Cross-Origin-Resource-Policy: same-origin`, `nosniff` e `CSP: default-src 'none'; sandbox`; tipo que não é
  vídeo/áudio/imagem sai como `application/octet-stream` (um HTML do Drive nunca roda com a origem do app).
- **Listagem**: `/list` e `/search` pedem também `hasThumbnail, thumbnailLink, iconLink, webViewLink, owners,
  videoMediaMetadata, imageMediaMetadata` (`BROWSE_FIELDS`; as varreduras grandes continuam com `FILE_FIELDS`).
  O DriveItem ganha, só quando vieram: `hasThumbnail, thumbnailLink, iconLink?, webViewLink?, owner?{name,email},
  video?{width,height,durationMs}, image?{width,height,camera?,exposureTime?,aperture?,isoSpeed?,focalLength?,time?}`.
  Os links de miniatura da listagem ficam guardados (30 min) para a rota não consultar o Drive arquivo por arquivo.
- **`thumb`**: `s` sobe para o próximo de `[64,128,220,320,480,640,960,1280,1600,2000]` e troca o `=s220` do link.
  Busca com o token da conta (local ou `nuvem:`; o token só vai para hosts do Google ou o da API), no máximo 6 ao mesmo
  tempo, pedidos iguais simultâneos viram um só. Link vencido (403/404/410) → consulta o arquivo de novo e tenta uma vez.
  Cache: LRU na memória (24 MB) + `<dados>/thumbs/<sha>.img` (256 MB; poda as menos usadas até 80%). A chave do cache
  inclui `v` (a interface manda o `modifiedTime`): arquivo novo, miniatura nova. Sem miniatura → 404.
- **`stream`**: repassa um Range simples (`bytes=a-b|a-|-n`) para `files/<id>?alt=media` e devolve 200/206/416 com
  `Content-Range`, `Content-Length` e `Accept-Ranges` (o Chromium precisa disso para pular no vídeo). 401 → renova o
  token uma vez. Quem fecha no meio (pulou na barra, trocou de arquivo) derruba a conexão com o Drive junto.
- **Proxy de câmera** (`/api/drive/:acc/proxy`): para o que o Chromium não toca (BRAW, R3D, ARI, MXF, ProRes…), procura
  o mesmo nome-base com `.mp4/.mov/.m4v` na mesma pasta ou numa subpasta irmã `Proxy`/`Proxies` (Blackmagic grava
  `A001_…_C001.braw` + `Proxy/A001_…_C001.mp4`). Uma consulta pelas subpastas (cache 5 min por pasta) + uma pelo nome
  (cache 5 min por arquivo); a subpasta Proxy e `.mp4` têm preferência. Só é chamado ao abrir a prévia.
- **Interface**: tela Drive alterna Lista/Miniaturas (lembrado em `sobedesce.drive.view`); a tabela mostra miniatura de
  28 px. Prévia (`components/drive-preview.js`) abre com duplo clique, espaço, Enter, o olho da linha ou "Prévia" na
  barra de seleção: player próprio (barra arrastável, tempo, volume, velocidade, tela cheia, quadro a quadro com
  Alt ←/→, ±5 s com Shift ←/→), foto com zoom (miniatura `=s2000` na hora, original JPG/PNG/WebP pelo stream),
  áudio, metadados. ←/→ trocam de arquivo, Esc fecha. "Baixar" no topo cria o download normal do motor
  (`POST /api/transfers/download` com o destino escolhido). Formato que não toca → procura o proxy (toca com o selo
  "Proxy"; o Baixar continua trazendo o original) → sem proxy, miniatura grande + "Este formato não toca na prévia".
  Na grade, original de câmera sem miniatura usa a do proxy que já está na pasta ou que a prévia achou.

### Interface (public/)

Preact + htm sem build (`/vendor/preact-htm.js` = `node_modules/htm/preact/standalone.module.js`).
Telas: **Transferências** (medidor ao vivo ↓/↑ com gráfico dos últimos 2 min, lotes agrupados,
barra de progresso que mostra os segmentos como clipes numa timeline de edição, pausar/retomar/cancelar,
filtros), **Primeiros passos** (sem nenhum Drive: "Entrar com a conta SOBEDESCE" — código grande, "Abrir no navegador",
"Pronto. Seus Drives apareceram aqui." — e, como alternativa, "Conectar um Drive só neste computador", que leva ao
caminho antigo da chave em `#/inicio/local`), **Drive** (navegar Meu Drive, Compartilhados comigo — rota `#/drive/compartilhados` — e drives compartilhados,
selecionar e baixar, enviar para a pasta atual; botão direito ou a tecla de menu numa linha/cartão abre o menu do item
em `components/drive-menu.js`, na camada das janelas: Abrir, Baixar, Enviar para esta pasta, Copiar link, Abrir no
Google Drive, Renomear, Mover para… (seletor de pasta), Calcular tamanho, Gerar proxy; arrastar linhas para cima de uma
pasta move), **Comparar** (pasta local × pasta do Drive, árvore com o que falta por pasta, botão
"Subir o que falta"), **Ajustes**.
Seletor de pastas/arquivos locais próprio (modal) usando `/api/local/*`.

### O que a interface espera do servidor (decidido ao construir a UI)

- `/api/state` traz `media: { key }` (chave das rotas de miniatura e stream).
- `/api/local/list?hidden=1` liga arquivos ocultos (ausente = desligado).
- `path` em `/api/drive/:acc/list` é o breadcrumb da raiz até a pasta atual, incluindo a atual. Drive compartilhado
  é navegado com `folderId` = id do drive. Upload na raiz manda `destFolderId: 'root'` (+ `driveId` quando for drive compartilhado).
- Eventos SSE podem vir como array puro ou embrulhados (`{ transfers: [...] }`); `batches` substitui a lista inteira,
  `transfers` mescla por id. Evento opcional `setup` (`{ configured, clientIdHint }`) também é tratado.
- Status de comparação: `running` → `done` | `error` | `canceled`. A UI também consulta `GET /api/compare/:jobId` a cada 2,5 s.
- `PublicTransfer.priority` (opcional; maior = primeiro) ordena a fila na UI, depois `createdAt`.
- Item pausado com `error.kind === 'reauth'` mostra "Conectar de novo" (→ `/api/auth/start`); se a conta é `nuvem:`,
  "Reconectar no site" (→ `<site>/conta`) ou, com a sessão encerrada, "Entrar na conta" (→ Ajustes).
- Ajustes começam por **Conta SOBEDESCE** (entrar/código, Drives com estado ok/reconectar, "Gerenciar Drives no site",
  "Atualizar", "Sair da conta") e têm **Drives só neste computador** (as contas locais). Voltar para a janela (focus) pede
  `/api/cloud/refresh` (no máximo a cada 20 s).
- Ajustes → Celular → Em qualquer lugar: QR para `<SOBEDESCE_CLOUD_URL>/app/` (o app do celular mora no site e usa a
  conta SOBEDESCE; sem client ID). Os ajustes antigos `mobileWebUrl`/`webClientId` ainda são aceitos, mas não mudam nada.
- Limites de banda na UI são MB/s decimais (× 1e6); pedaço de upload em MiB (0 = contínuo).
- Servir de `public/`: `/favicon.svg`, `/lib/*`, `/components/*`, `/app.js`, `/styles.css`. Sem scripts inline (CSP estrita funciona).
- Depois do OAuth, o callback leva para `/` (a UI recarrega `/api/state`).

## App de desktop (Electron) — contrato com `src/index.js`

O app de desktop (`desktop/`) reaproveita o motor inteiro: o processo principal do Electron sobe o motor com
`utilityProcess.fork('desktop/engine.js')`, que importa `startApp` de `src/index.js`, e abre uma janela na URL local.
Por isso `src/index.js` precisa:

- Exportar `startApp({ home, port, open = true, desktop = false }) → { url, port, manager, shutdown() }`
  (usado pelo demo, pelos testes e pelo desktop). `shutdown()` pausa tudo, grava a fila e fecha o servidor.
- **Não** iniciar nada ao ser importado: só roda `main()` quando executado direto
  (`import.meta.url === pathToFileURL(process.argv[1]).href`).
- Trava de instância: `startApp` cria `<home>/engine.lock` com o pid; se outro motor vivo já usa a mesma pasta de dados,
  falha com `Error('O SOBEDESCE já está aberto neste computador.')` + `err.code = 'ALREADY_RUNNING'` + `err.url` (lido do lock).
  Lock de processo morto é ignorado e sobrescrito; removido no shutdown.
- Com `desktop: true` não abre navegador, e a página de retorno do OAuth (aberta no navegador do sistema, porque o
  Google bloqueia login dentro de apps Electron) diz "Conta conectada. Pode voltar para o SOBEDESCE." em vez de
  redirecionar para a interface.

**Tela grande** (`desktop/zoom.js`): as páginas ocupam a janela toda (`.page` sem coluna estreita, margem lateral
`--page-x` de 32 a 64 px, teto de 2200 px só em 5K; grade do Drive e das Referências com mais colunas e miniaturas que
crescem; Ajustes com índice e, a partir de 1900 px de CSS, os grupos em duas colunas). Além disso o app cresce junto com
a janela pelo zoom do Chromium (`setZoomFactor`, não `zoom` no CSS, para cliques e medidas continuarem batendo): 1× até
1600 px de largura, 1,1× em 1920, 1,3× em 2560 e no máximo 1,4×. O menu Visualizar (Aumentar, Diminuir, Tamanho real;
Cmd/Ctrl +, -, 0) e o Cmd/Ctrl + rodinha multiplicam por cima, em passos, e a escolha fica em `<userData>/zoom.json`.

O protocolo com o processo principal fica em `desktop/engine.js` (`ready` / `fatal` / `shutdown` via `process.parentPort`).
`src/index.js` sobe o pool de threads do libuv para 16 (`UV_THREADPOOL_SIZE`, antes do primeiro uso; o desktop repassa no
`fork`): com 4, alguns `fdatasync` longos de downloads a 1–10 Gbps travavam as gravações e a leitura do MD5.

Segurança da janela (`desktop/security.js`, testado sem Electron): toda mensagem da ponte (`ipcMain`) só é atendida se vier
do quadro principal com a origem do motor; permissões da web negadas (só `clipboard-sanitized-write` para a interface).

Recepção do celular (`src/mobile/receiver.js`):
- **Pontos.** `offset` (o que o celular ouve e de onde continua) é o que já foi gravado, contíguo, e avança no fim de
  cada PUT. `mobile-uploads.json` guarda `synced`, que só avança depois do `fdatasync`. Se o computador desligar, o
  celular continua do ponto sincronizado e manda o resto de novo (nunca um buraco de zeros no arquivo). O progresso ao
  vivo, no meio de um PUT, fica só na memória (tela de Ajustes e envio em fluxo).
- **`fdatasync` espaçado** (relatório de rede, 4.9): a cada 64 MiB gravados (`SYNC_EVERY`), no fim do arquivo (antes de
  dar o nome e enfileirar; sem ele o arquivo não é dado como recebido) e ao fechar a recepção/o app. Antes era a cada
  pedaço do celular (8–16 MiB); no macOS ele vira `F_FULLFSYNC`, que esvazia o cache do disco.
- **Em fluxo** (relatório de rede, 4.12): arquivo do app com 32 MiB ou mais (`streamMinBytes`), destino decidido (a
  pasta é consultada para saber o drive compartilhado; sem resposta em 15 s, segue o caminho antigo) e
  `manager.canStartUpload()` (vaga livre agora, ninguém da fila na frente, nenhuma espera de cota da conta e uso de 24 h +
  tamanho ≤ 750 GB). Aí o envio entra na fila no começo do recebimento (`local.growing`, `local.stream`, `local.path` =
  o `.part`) com um `ReceiveFeed`, e sobe enquanto chega: tempo total ≈ a perna mais lenta. Pergunta de novo a cada PUT
  do celular (no máximo a cada 2 s): se uma vaga abrir no meio do recebimento, passa a subir em fluxo dali. Senão (sem
  vaga, cota, arquivo pequeno, Atalho do iPhone, outro arquivo com o mesmo nome indo para a mesma pasta): recebe tudo
  e só depois enfileira, como antes.
  - Celular parou: o envio fecha o PUT, espera e solta a vaga ('queued', "Esperando o celular"); quando o celular volta
    e manda o resto, o envio retoma do ponto do Google na mesma sessão.
  - Celular cancelou (DELETE): o envio sai da fila (a sessão no Google é encerrada) e o `.part` é apagado.
  - Cancelado/tirado da fila no computador no meio: o recebimento continua, mas não enfileira de novo sozinho.
  - Reabrir o app no meio: o feed é religado ao envio (chegando, inteiro ou perdido); envio em fluxo sem recebimento por
    trás sai da fila.
  - Transferências mostra os dois progressos: o que já chegou atrás (como o "carregado" de um player) e o que subiu na
    frente, mais a linha "Chegando do celular: X de Y · sobe junto".

Empacotamento (`electron-builder.yml`, com asar): `package.json`, `desktop/`, `src/`, `public/` e a casca do app do celular
(`web/public/app/index.html`, `app.*`, `lib/`, `components/`, `vendor/`, `icons/`), que a recepção pelo Wi-Fi serve em `/m/`,
vão dentro do `app.asar` (o Electron lê ESM, `utilityProcess.fork`, `worker_threads` e `fs` do motor de dentro dele).
Em `extraResources` (fora do asar, executáveis): `ffmpeg/` (por arquitetura), `ffmpeg-licencas/`, `yt-dlp/`, `quickjs/`
(por arquitetura) e `quickjs-licenca/`. Nada precisa de `asarUnpack`.

### Proteção do app de desktop (revisão de segurança A9)

**Fusíveis** (`electronFuses` no `electron-builder.yml`, aplicados pelo electron-builder com `@electron/fuses` antes de
assinar): `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off,
`EnableCookieEncryption` on, `OnlyLoadAppFromAsar` on e `EnableEmbeddedAsarIntegrityValidation` on (o hash do `app.asar`
vai no Info.plist no Mac e no recurso do `.exe` no Windows: JavaScript trocado no disco = app não abre).
Sem assinatura da Apple/Microsoft (por enquanto), a integridade do asar ainda pode ser contornada por quem refaz a
assinatura ad-hoc; ela pega a troca simples de arquivos, e no Mac o app re-assinado perde as permissões já dadas (TCC).

**Segredos no disco** (`src/util/segredos.js`): `accounts.json`, `credentials.json` e `cloud.json` passam por
`ArquivoSecreto(arquivo, { guarda })`. Guarda = `{ nome, disponivel(), cifrar(texto) → Buffer, decifrar(Buffer) → texto }`
(assíncrona). Sem guarda (npm start, testes, modo servidor) = JSON 0600 de sempre. No app de desktop, a guarda é o
`safeStorage` do Electron, que só existe no processo principal: o motor usa `guardaPorMensagens` (`{ type: 'cofre', id,
op: 'estado'|'cifrar'|'decifrar', dados (base64) }` → `{ type: 'cofre-resposta', id, ok, disponivel?, dados?, erro? }`,
2 min de espera por causa da pergunta do Keychain) e o processo principal responde com `responderCofre`
(`desktop/cofre.js`). Linux com `basic_text` (sem keyring) conta como indisponível.
- Arquivo cifrado: `<nome>.cifrado.json` (0600) = `{ "sobedesce-cofre": 1, guarda, dados: base64 }`.
- Migração transparente: com a guarda disponível, o JSON antigo é lido, cifrado, conferido (decifra de volta) e só então
  apagado. Guarda indisponível = segue o JSON, com um aviso no log (uma vez).
- Nada some: cifrado que não abre (corrompido, outra chave, Keychain negado) fica no lugar e o app segue sem ele; antes de
  gravar por cima, vira `<nome>.cifrado.json.guardado-<data>`. Se os dois existem, vale o mais novo (mtime).
- `AuthManager.protecao` (`'sistema'|'arquivo'`) vai em `/api/state` → `app.protecao` (Ajustes → Avançado → "Onde ficam
  os acessos"). Fora do escopo por enquanto: `mobile.json` (código da recepção pelo Wi-Fi, `src/mobile/receiver.js`).

**Cookies do navegador de Referências** (`desktop/cookies-cifrados.js`): com `EnableCookieEncryption`, o Chromium só cifra
o que grava daqui em diante. Na primeira abertura do app empacotado, antes de a sessão `persist:navegador` existir, os
arquivos `Partitions/navegador/{,Network/}Cookies*` são apagados (marca `cookies-cifrados.json` na pasta do Electron); ao
abrir o navegador, um aviso único diz "Entre de novo no Instagram uma vez". Ligar o fusível é sem volta: desligar de novo
deixa os cookies cifrados ilegíveis.

**Teste de fumaça** (`SOBEDESCE --smoke`, `desktop/smoke.js`): sem janela e sem a trava de instância, numa pasta temporária
(dados, `userData`, logs) e numa porta aleatória, o processo principal sobe o motor de verdade e pede `{ type: 'smoke' }`;
o motor confere `/api/state`, a interface servida (`/`, `/app.js`, `/styles.css`, `/components/settings.js`), a casca do
app do celular, o MD5 no worker, ffmpeg (`-version`), yt-dlp (`--version`) e QuickJS (`--help`) de dentro do app, e um
ciclo cifrar/decifrar pelo cofre. Escreve uma linha por item, `SMOKE OK` / `SMOKE FALHOU` (também no arquivo
`SOBEDESCE_SMOKE_SAIDA`, se definido) e sai com 0 / 1 (2 = passou de 4 min). No Mac/Windows empacotado, faltar binário
é falha (o ffmpeg do Windows ARM é exceção); o cofre só é exigido no Windows (no Mac do CI o Keychain pode estar
travado: vira AVISO). O workflow roda isso no Mac e no Windows depois do build, também em pull requests, antes de
publicar; e mostra os fusíveis com `electron-fuses read`.
Sair com transferência ativa sempre pergunta (X da janela no Windows/Linux, ⌘Q no Mac, Arquivo → Sair); confirmado, o motor
pausa, grava a fila e só então o app fecha.

A janela do Electron carrega a mesma interface; `window.sobedesce` (preload) oferece extras nativos:
`{ desktop: true, platform, pickFolder({ title, defaultPath }) → string|null,
pickPaths({ title, defaultPath, kind: 'any'|'files' }) → string[] (no Windows/Linux só seleciona arquivos),
pathForFile(File) → string, setProgress(fraction|null, activeCount), notify(title, body), openExternal(url), reveal(path) }`.
A interface usa esses extras quando existem (seletor nativo, arrastar do Finder/Explorer, progresso no Dock/barra de
tarefas) e cai no seletor próprio quando roda no navegador.
