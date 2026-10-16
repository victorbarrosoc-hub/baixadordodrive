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
| `SOBEDESCE_GOOGLE_BASE` | Só testes: Google falso. Ignorada se `VERCEL` ou `NODE_ENV=production`, e só aceita 127.0.0.1/localhost. |

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
  (sha256), `nome`, `plataforma`, `usuarioId` (null até aprovar), `aprovadoEm`, `usadoEm`, `expiraEm` (10 min), `criadoEm`.
- `tentativas`: limite de tentativas (login por e-mail+IP, criação de conta por IP, código de
  dispositivo por IP). `chave`, `quando`. Limpeza preguiçosa.

Migrações em `web/drizzle/` (`npm run db:generate`). Na Vercel o `vercel-build` aplica antes do build.

## 4. Sessão

- Web: cookie `sd_sessao` = token aleatório (32 bytes base64url). No banco só o sha256.
  `httpOnly`, `secure` (fora do localhost), `sameSite=lax`, `path=/`, 30 dias.
- Dispositivo: `Authorization: Bearer sdd_<token>`. Mesma tabela, `tipo=dispositivo`.
- `web/src/lib/auth/`:
  - `usuarioAtual()`: lê cookie **ou** Bearer, devolve `{ usuario, sessao } | null`.
  - `exigirUsuario()`: redireciona para `/entrar?volta=...`.
- Server Actions e rotas que mudam algo: `exigirUsuario()` primeiro. Rotas com cookie conferem
  `Origin` (CSRF). Rotas com Bearer não usam cookie.

## 5. API (JSON, `Cache-Control: no-store`)

Todas aceitam cookie (`sd_sessao`) ou Bearer de dispositivo, salvo onde dito.
Erro: `{ "erro": "<codigo>", "mensagem": "<texto para a tela>" }` com o status HTTP.

| Método e caminho | Entrada | Saída |
|---|---|---|
| `GET /api/eu` | | `200 { usuario: { id, email, nome }, contas: Conta[] }` · `401 { erro: "sem_sessao" }` |
| `GET /api/drive/contas` | | `200 { contas: Conta[] }` |
| `POST /api/drive/token` | `{ conta: "<id>", renovar?: boolean }` | `200 { accessToken, expiraEm (ms epoch), email }` · `404 nao_encontrada` · `409 { erro: "reconectar", mensagem }` · `502 google` |
| `POST /api/dispositivo/iniciar` | `{ nome, plataforma }` (sem sessão) | `200 { codigo, segredo, url, intervalo: 3, expiraEm }` |
| `POST /api/dispositivo/aguardar` | `{ segredo }` (sem sessão) | `202 { estado: "pendente" }` · `200 { estado: "pronto", token: "sdd_...", usuario }` (uma vez só) · `410 { erro: "expirado" }` · `429 devagar` |
| `POST /api/dispositivo/sair` | Bearer | `204` (revoga a própria sessão) |
| `GET /api/google/conectar?modo=vincular\|entrar&volta=/conta` | | 302 para o Google (state + PKCE em cookie assinado de 10 min) |
| `GET /api/google/callback` | | 302 para `volta` com `?google=ok` ou `?erro=<codigo>` |

`Conta = { id, email, nome, fotoUrl, estado: "ok" | "reconectar" }`. Nunca sai token de refresh.

`/api/drive/token`: devolve o access token guardado se faltar mais de 5 min para vencer; senão
renova no Google (uma renovação por vez por conta). `invalid_grant` → `estado=reconectar` e 409.

## 6. Telas

| Caminho | Frente | O que é |
|---|---|---|
| `/` | home | Página inicial animada (downloads do .dmg/.exe, celular, criar conta). |
| `/privacidade`, `/termos` | home | Exigidas pela tela de consentimento do Google. |
| `/entrar`, `/criar-conta` | contas | E-mail e senha. `/entrar` também tem "Entrar com Google". |
| `/conta` | contas | Drives conectados (conectar, reconectar, remover), computadores conectados (desconectar), dados da conta, sair. |
| `/dispositivo?codigo=` | contas | Liberar um computador (pede login). |
| `/app` | celular | O envio pelo celular (PWA), usando os Drives da conta. |

Cabeçalho e rodapé do site: `web/src/components/site/` (frente home). As telas de conta usam
`web/src/components/ui/` (Button, Input, Field, Card).

Downloads do desktop: Release `versao-de-teste` do GitHub
(`https://github.com/victorbarrosoc-hub/baixadordodrive/releases/tag/versao-de-teste`).

## 7. Desktop

- `src/google/cloud-auth.js`: contas da nuvem com a mesma interface do `AuthManager`
  (`listAccounts`, `getAccessToken(accountId, { forceRefresh })`, evento `accounts`). Ids das
  contas da nuvem: `nuvem:<id>`. As contas locais (OAuth no próprio computador) continuam.
- Entrar: `POST /api/dispositivo/iniciar` → abre o navegador em `url` → `aguardar` a cada
  `intervalo` s → guarda o token no diretório de dados (arquivo 0600).
- Servidor: `https://sobedesce.vercel.app` (`SOBEDESCE_CLOUD_URL` troca, para testes).
