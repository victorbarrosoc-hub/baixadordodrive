# Contas SOBEDESCE: contrato

Site novo em `web/` (Next.js 16, Tailwind 4, Drizzle). Produção: Vercel, projeto `sobedesce`
(https://sobedesce.vercel.app), banco Neon (`DATABASE_URL`). Computador: PGlite (`npm run dev`).

Este documento é o contrato entre as quatro frentes: **contas** (servidor + telas de conta),
**home** (página inicial e páginas legais), **celular** (`/app`) e **desktop** (app Electron).
Mudou algo aqui? Avise as outras frentes.

## 1. Decisões do Victor

- Público: **equipe e convidados**. O app do Google fica em modo **Teste** (até 100 e-mails
  cadastrados à mão no Google Cloud). Escopo **Drive completo**
  (`https://www.googleapis.com/auth/drive`). No modo Teste o refresh token do Google vence em
  **7 dias**: a tela precisa lidar bem com "reconectar".
- Login: **conta própria da SOBEDESCE** (e-mail + senha). Dentro da conta, **"Conectar Google
  Drive"** vincula uma ou mais contas Google. Depois de vinculada, a conta Google também serve
  para **entrar** ("Entrar com Google").
- O **app de computador** também entra na conta (fluxo de dispositivo) e usa os Drives dela.
- Visual: Apple + ElevenLabs. Calma, preto e branco, pílulas, muito respiro.
  Violeta (`up`) = envio, azul (`down`) = download. Tokens em `web/src/app/globals.css`
  (os nomes são contrato; os valores podem mudar).
- Textos em português do Brasil, frases curtas, sem ponto de exclamação, sem clichê.

## 2. Variáveis de ambiente (web)

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Neon (pooler). Criada pela integração Neon da Vercel. |
| `GOOGLE_CLIENT_ID` | Cliente OAuth "Aplicativo da Web" oficial (`235961238964-e87vitlplbrnu5kb3vsfms7tjgt98q4b...`). |
| `GOOGLE_CLIENT_SECRET` | Segredo do mesmo cliente. |
| `SOBEDESCE_KEY` | 32 bytes em base64. Cifra AES-256-GCM dos tokens do Google. |
| `NEXT_PUBLIC_SITE_URL` | Opcional. Padrão `https://sobedesce.vercel.app`. |
| `SOBEDESCE_GOOGLE_BASE` | Só testes: Google falso. Ignorada se `VERCEL` ou `NODE_ENV=production`, e só aceita 127.0.0.1/localhost. Caminhos usados: `/o/oauth2/v2/auth`, `/token`, `/revoke`, `/v1/userinfo` (o Google falso das contas está em `web/tests/google-falso.mts`). |
| `RESEND_API_KEY` | E-mail transacional (Resend, `POST https://api.resend.com/emails`, sem SDK). Sem ela: em dev o e-mail vai para o console; em produção não envia e `/esqueci-a-senha` mostra "indisponível". |
| `EMAIL_REMETENTE` | Opcional. Padrão `SOBEDESCE <nao-responda@dissesim.com.br>` (o domínio precisa estar verificado no Resend). |
| `SOBEDESCE_RESEND_BASE` | Só testes: Resend falso (`web/tests/resend-falso.mts`). Mesma regra do Google falso. |
| `SOBEDESCE_PGLITE_DIR` | Só testes/local: onde fica o PGlite (padrão `./data/pglite`; `memory://` = em memória). |

Redirect do Google: `https://sobedesce.vercel.app/api/google/callback`
(local: `http://localhost:3000/api/google/callback`).

## 3. Banco (Drizzle, `web/src/lib/db/schema.ts`, casing snake_case)

- `usuarios`: `id` (texto, aleatório), `email` (único, minúsculo), `nome`, `senhaHash` (scrypt
  do node:crypto, com sal; formato `scrypt$N$r$p$sal$hash`), `criadoEm`, `atualizadoEm`, `ultimoLoginEm`.
- `sessoes`: `id`, `usuarioId`, `tokenHash` (sha256 hex, único), `tipo` (`web` | `dispositivo`),
  `nome` (dispositivo: "MacBook Pro de Victor"), `plataforma` (`mac` | `windows` | `linux` | null),
  `criadoEm`, `ultimoUsoEm`, `expiraEm` (web: 30 dias deslizantes; dispositivo: 180 dias
  deslizantes), `revogadaEm`.
- `contasGoogle`: `id`, `usuarioId`, `googleSub` (único: uma conta Google pertence a uma só conta
  SOBEDESCE), `email`, `nome`, `fotoUrl`, `refreshTokenEnc`, `accessTokenEnc`, `accessExpiraEm`,
  `escopos`, `estado` (`ok` | `reconectar`), `criadoEm`, `atualizadoEm`.
- `codigosDispositivo`: `id`, `codigo` (único, `ABCD-EFGH`, sem letras ambíguas), `segredoHash`
  (sha256, único), `nome`, `plataforma`, `usuarioId` (null até aprovar), `aprovadoEm`, `usadoEm`,
  `consultadoEm` (última consulta do `/aguardar`, para o 429), `expiraEm` (10 min), `criadoEm`.
- `redefinicoesSenha`: "Esqueci a senha". `id`, `usuarioId`, `tokenHash` (sha256, único), `expiraEm` (1 h),
  `usadoEm` (uso único), `criadoEm`.
- `tentativas`: limite de tentativas (login por e-mail+IP, criação de conta por IP, código de
  dispositivo por IP). `id` (identity), `chave`, `quando`. Limpeza preguiçosa.
  Regras atuais (`web/src/lib/auth/limite.ts`): login 8 erros/15 min por e-mail+IP e 40/15 min por IP;
  criar conta 10/h por IP; esqueci a senha 3/h por e-mail e 10/h por IP; apagar conta 8 senhas erradas/15 min; `/api/dispositivo/iniciar` 30/h por IP; código errado na tela 20/15 min por IP.

Migrações em `web/drizzle/` (`npm run db:generate`). Na Vercel o `vercel-build` aplica antes do build.

## 4. Sessão

- Web: cookie `sd_sessao` = token aleatório (32 bytes base64url). No banco só o sha256.
  `httpOnly`, `secure` (fora do localhost), `sameSite=lax`, `path=/`, 30 dias.
- Dispositivo: `Authorization: Bearer sdd_<token>`. Mesma tabela, `tipo=dispositivo`.
- `web/src/lib/auth/atual.ts` (páginas e Server Actions, usa `next/headers`):
  - `usuarioAtual()`: lê cookie **ou** Bearer, devolve `{ usuario, sessao, via: "cookie" | "bearer" } | null`.
  - `exigirUsuario(volta)`: redireciona para `/entrar?volta=...`.
- `web/src/lib/auth/requisicao.ts` (rotas da API, só `Request`):
  `usuarioDaRequisicao(req)` e `exigirNaApi(req, { mutacao })` (sessão + Origin quando veio do cookie).
- Com `Authorization` presente, só o Bearer conta (o cookie é ignorado). O token do site não vale como Bearer.
- Server Actions e rotas que mudam algo: sessão primeiro. Rotas com cookie conferem
  `Origin` (CSRF: sem Origin, `null` ou de outro site = 403 `origem`). Rotas com Bearer não usam cookie.
  O navegador manda Origin sozinho em `fetch` POST da mesma origem: a PWA `/app` não precisa fazer nada.
- `web/src/proxy.ts` regrava o cookie (mais 30 dias) em `/conta`, `/dispositivo` e `/app/*`.
- Trocar a senha encerra as outras sessões (site e computadores) e mantém a atual.

## 5. API (JSON, `Cache-Control: no-store`)

Todas aceitam cookie (`sd_sessao`) ou Bearer de dispositivo, salvo onde dito.
Erro: `{ "erro": "<codigo>", "mensagem": "<texto para a tela>" }` com o status HTTP.
Códigos comuns: `401 sem_sessao`, `403 origem` (cookie sem Origin do site), `400 entrada` (corpo ruim).

| Método e caminho | Entrada | Saída |
|---|---|---|
| `GET /api/eu` | | `200 { usuario: { id, email, nome }, contas: Conta[] }` · `401 { erro: "sem_sessao" }` |
| `GET /api/drive/contas` | | `200 { contas: Conta[] }` |
| `POST /api/drive/token` | `{ conta: "<id>", renovar?: boolean }` | `200 { accessToken, expiraEm (ms epoch), email }` · `404 nao_encontrada` · `409 { erro: "reconectar", mensagem }` · `502 google` · `503 sem_config` |
| `POST /api/dispositivo/iniciar` | `{ nome, plataforma }` (sem sessão; `plataforma` fora de mac/windows/linux vira null) | `200 { codigo, segredo, url, intervalo: 3, expiraEm }` · `429 devagar` |
| `POST /api/dispositivo/aguardar` | `{ segredo }` (sem sessão) | `202 { estado: "pendente" }` · `200 { estado: "pronto", token: "sdd_...", usuario }` (uma vez só) · `410 { erro: "expirado" }` (vencido, cancelado, já usado ou segredo desconhecido) · `429 devagar` (menos de 2 s desde a consulta anterior; `Retry-After: 3`) |
| `POST /api/dispositivo/sair` | Bearer | `204` (revoga a própria sessão) |
| `GET /api/google/conectar?modo=vincular\|entrar&volta=/conta` | | 302 para o Google (state + PKCE em cookie assinado de 10 min) |
| `GET /api/google/callback` | | 302 para `volta` com `?google=ok` ou `?erro=<codigo>` |

`Conta = { id, email, nome, fotoUrl, estado: "ok" | "reconectar" }`. Nunca sai token de refresh.

Erros que o callback devolve em `?erro=` (textos em `web/src/components/conta/mensagens.ts`):
`google_recusado` (access_denied), `google_sem_conta` (entrar com conta Google não vinculada: vai para
`/entrar`), `google_outra_conta` (a conta Google já é de outro usuário; nada é gravado nem revogado),
`google_sem_drive` (desmarcou o Drive no consentimento), `google_expirou` (cookie/state vencido ou
trocado), `google_erro`, `google_config`. "Entrar com Google" também renova os tokens guardados
(tira o "reconectar"). Vincular de novo a mesma conta Google é o "Reconectar" (mesmo `id`).

`/api/drive/token`: devolve o access token guardado se faltar mais de 5 min para vencer; senão
renova no Google (uma renovação por vez por conta). `invalid_grant` → `estado=reconectar` e 409.

## 6. Telas

| Caminho | Frente | O que é |
|---|---|---|
| `/` | home | Página inicial animada (downloads do .dmg/.exe, celular, criar conta). |
| `/privacidade`, `/termos` | home | Exigidas pela tela de consentimento do Google. |
| `/entrar`, `/criar-conta` | contas | E-mail e senha. `/entrar` também tem "Entrar com Google". |
| `/conta` | contas | Drives conectados (conectar, reconectar, remover), computadores conectados (desconectar), dados da conta, sair, apagar a conta. |
| `/dispositivo?codigo=` | contas | Liberar um computador (pede login). Ao liberar, a conta recebe um e-mail de aviso. |
| `/esqueci-a-senha`, `/nova-senha` | contas | Senha nova por e-mail. |
| `/app` | celular | O envio pelo celular (PWA), usando os Drives da conta. |

Cabeçalho e rodapé do site: `web/src/components/site/` (frente home). As telas de conta usam
`web/src/components/ui/` (Button, Input, Field, Card) e um cabeçalho simples próprio em
`web/src/components/conta/`. Ficam no grupo `web/src/app/(conta)/`, junto com `/esqueci-a-senha`
(resposta sempre igual) e `/nova-senha?token=` (link de 1 h, uso único; ao salvar, todas as sessões
antigas caem, inclusive computadores, e a pessoa entra); `/sair` pede um toque (POST),
um link não derruba a sessão. `/dispositivo` sem `codigo` mostra um campo para digitar o código.

Downloads do desktop: Release `versao-de-teste` do GitHub
(`https://github.com/victorbarrosoc-hub/baixadordodrive/releases/tag/versao-de-teste`).

## 7. Desktop

- `src/google/cloud-auth.js`: contas da nuvem com a mesma interface do `AuthManager`
  (`listAccounts`, `getAccessToken(accountId, { forceRefresh })`, evento `accounts`). Ids das
  contas da nuvem: `nuvem:<id>`. As contas locais (OAuth no próprio computador) continuam.
- Entrar: `POST /api/dispositivo/iniciar` → abre o navegador em `url` → `aguardar` a cada
  `intervalo` s → guarda o token no diretório de dados (arquivo 0600).
- Servidor: `https://sobedesce.vercel.app` (`SOBEDESCE_CLOUD_URL` troca, para testes).

## 8. Apagar a conta e e-mails

- **Apagar minha conta** (fim de `/conta`): diálogo com a senha atual e a palavra `APAGAR`; o servidor
  confere as duas (`web/src/lib/auth/apagar.ts`). Revoga no Google o token de cada Drive (melhor
  esforço), encerra todas as sessões (site e computadores: o Bearer passa a dar 401), apaga contas
  Google, códigos de dispositivo, links de senha e o usuário, limpa o cookie e leva para `/?conta=apagada`
  (a home mostra "Conta apagada."). Conta sem senha (só Google, se um dia existir): vale um login
  feito há menos de 15 min.
- **E-mails** (`web/src/lib/email/`, HTML preto e branco + texto, enviados depois da resposta com `after`):
  senha nova, conta apagada (confirmação) e computador conectado (nome, sistema, quando, "Se não foi
  você, desconecte em Sua conta").
