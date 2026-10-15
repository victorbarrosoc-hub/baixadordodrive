# Notas verificadas sobre a API do Google Drive (out/2026)

Resumo da pesquisa que guiou o motor. Fontes: developers.google.com/workspace/drive, developers.google.com/identity,
código e fórum do rclone. Onde está "não documentado", o motor se protege dos dois lados.

## Upload retomável
- Início: `POST {upload}/files?uploadType=resumable&supportsAllDrives=true&fields=…` (ou `PATCH {upload}/files/{id}?uploadType=resumable`
  para trocar o conteúdo de um arquivo existente). Headers `Content-Type: application/json; charset=UTF-8`,
  `X-Upload-Content-Type`, `X-Upload-Content-Length`. Resposta 200 sem corpo; a URI da sessão vem no `Location`.
- A URI da sessão vale **1 semana** e funciona como credencial (não logar, não mandar para a UI).
- Envio: `PUT <sessão>` com `Content-Range: bytes A-B/TOTAL` (B inclusivo). Pedaços intermediários: múltiplos de 256 KiB.
  O Google **recomenda uma requisição só** com tudo que falta (menos requisições, sem pausas entre pedaços).
- `308 Resume Incomplete` + `Range: bytes=0-N` → próximo byte é N+1. Sem `Range` → nada foi gravado.
  Nunca supor que tudo que foi enviado chegou. 308 não é redirecionamento.
- Consulta de status: `PUT` vazio, `Content-Length: 0`, `Content-Range: bytes */TOTAL` → 308 (continuar), 200/201 (já terminou),
  404/410 (sessão morreu: recomeçar do zero).
- Partes de UM arquivo não podem subir em paralelo. Paralelismo = vários arquivos.
- Um fluxo costuma render ~40–100 MB/s (relatos de 2025: ~40 MB/s por arquivo num link de 1 Gbps, escalando linear com arquivos simultâneos).
- Retentáveis: 5xx, 429, 403 `rateLimitExceeded`/`userRateLimitExceeded`, queda de conexão. Fatais: `storageQuotaExceeded`,
  `teamDriveFileLimitExceeded`, `numChildrenInNonRootLimitExceeded`, `insufficientFilePermissions`…
- Limite de **750 GB/dia** por usuário (upload + cópia). Chega como 403 `userRateLimitExceeded` "User rate limit exceeded." —
  igual ao limite de taxa. O arquivo que cruza o limite termina. Libera em até 24 h. Tamanho máximo por arquivo: 5 TB.
- `md5Checksum` existe para arquivos binários (pedir em `fields`). Docs/atalhos não têm checksum.

## Download
- `GET {api}/files/{id}?alt=media&supportsAllDrives=true` com `Range` → 206. Validar `Content-Range` antes de gravar.
- Arquivo de 0 byte: Range falha — criar vazio sem requisição.
- Uma conexão sozinha raramente enche o link; várias conexões com Range sim (rclone: 4 fluxos, blocos de 64 MiB).
- **HTTP/2 multiplexa tudo numa conexão TCP** e mata o ganho. undici 8 liga h2 por padrão: usamos undici 7 com `allowH2: false`.
- Corpo de resposta do undici precisa ser consumido ou destruído, senão a conexão vaza.
- `downloadQuotaExceeded`: cota do arquivo (muito baixado/compartilhado). Repetir logo não adianta: esperar 15 min → 24 h.
- `cannotDownloadAbusiveFile`: só com `acknowledgeAbuse=true` e confirmação do usuário (e só dono/gerente). Tratamos como fatal com explicação.
- `capabilities.canDownload=false`: o dono bloqueou. Docs nativos: `files.export` (limite de 10 MB, sem Range, sem checksum).
- Itens antigos compartilhados por link podem exigir `X-Goog-Drive-Resource-Keys: id/resourceKey`.
- Limite diário de download não documentado (~10 TB/dia segundo o rclone).

## Listagem
- `files.list`: no máx. 1000 por página, `q='<id>' in parents and trashed=false`, `supportsAllDrives=true`,
  `includeItemsFromAllDrives=true`; dentro de drive compartilhado `corpora=drive&driveId=…`. `drives.list` até 100 por página.
- Desde mai/2026 as cotas são em "unidades": 325.000/min por usuário por projeto; `files.list` custa 100, `files.get` 5.
  Na prática: até ~8 listagens simultâneas e ~20 req/s com recuo em 403/429.
- Atalhos (`application/vnd.google-apps.shortcut`) apontam para `shortcutDetails.targetId`.

## OAuth (app local)
- Fluxo loopback: `redirect_uri=http://127.0.0.1:<porta>/oauth/callback`, PKCE S256, `access_type=offline`, `prompt=consent`.
  Endpoints: `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `oauth2.googleapis.com/revoke`.
- Clientes "App para computador" são públicos, mas o token endpoint **ainda pede `client_secret`** — sempre enviar.
- Escopo: `https://www.googleapis.com/auth/drive` (o único que permite listar/baixar qualquer arquivo e subir em qualquer pasta).
  `drive.file` não serve para o comparador. O usuário pode desmarcar a permissão (consentimento granular): conferir `scope` na resposta.
- Identidade sem escopos extras: `GET {api}/about?fields=user(displayName,emailAddress,permissionId,photoLink),storageQuota`.
- **Modo Teste: refresh token expira em 7 dias.** Para não reconectar toda semana: publicar o app (Público-alvo → Publicar app)
  sem pedir verificação (uso pessoal, < 100 usuários; aparece a tela "O Google não verificou este app"). Desde ago/2026 o botão
  Publicar pode exigir página inicial, política de privacidade e domínio autorizado no Branding. Contas Google Workspace podem
  escolher "Interno" (sem aviso, sem expiração de 7 dias).
- Refresh token também morre: revogado, 6 meses sem uso, > 100 tokens por conta/cliente. `invalid_grant` = reconectar.
- O segredo do cliente só aparece uma vez ao criar: **baixar o JSON antes de fechar a janela**. Clientes sem uso por 6 meses são apagados.
- Cada usuário usa o próprio projeto/cliente: a cota (e qualquer cobrança futura do Google) fica isolada.
