# Contas SOBEDESCE: contrato

Site novo em `web/` (Next.js 16, Tailwind 4, Drizzle). Produção: Vercel, projeto `sobedesce`
(https://sobedesce.vercel.app), banco Neon (`DATABASE_URL`). Computador: PGlite (`npm run dev`).

Este documento é o contrato entre as quatro frentes: **contas** (servidor + telas de conta),
**home** (página inicial e páginas legais), **celular** (`/app`) e **desktop** (app Electron).
Mudou algo aqui? Avise as outras frentes.

## 1. Decisões do Victor

- Público: o app do Google está **publicado sem verificação** (projeto `zro-site-511809`, o
  mesmo da ZRO): qualquer conta Google conecta, depois do aviso "O Google não verificou este app",
  com limite de cerca de 100 usuários até verificar. Escopo **Drive completo**
  (`https://www.googleapis.com/auth/drive`). O refresh token não vence mais em 7 dias, mas a tela
  continua lidando bem com "reconectar" (senha trocada, acesso removido).
- Login: **conta própria da SOBEDESCE** (e-mail + senha). Dentro da conta, **"Conectar Google
  Drive"** vincula uma ou mais contas Google. Só **uma** delas serve para **entrar** ("Entrar com
  Google"): a que criou a conta, ou a escolhida em `/conta` → "Entrar com Google" (pede a senha atual).
  Conectar outro Drive não abre a conta (`contas_google.login_permitido`, no máximo um por conta).
  Conta criada pelo Google cria a primeira senha só pelo link no e-mail, nunca só com a sessão aberta.
- Admin (`/admin`): e-mail de `SOBEDESCE_ADMINS` num Drive conectado **com e-mail confirmado pelo
  Google** (`contas_google.email_verificado`, gravado a cada conexão ou entrada).
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
| `VAPID_PRIVATE_KEY` | Chave privada VAPID (Web Push, §9). Sem ela, os avisos no celular ficam desligados e o resto funciona. A pública fica no código (`web/src/lib/acompanhar/push.ts`). |
| `VAPID_PUBLIC_KEY` | Opcional. Troca a chave pública do código (só se gerar um par novo; inscrições antigas param de receber). |
| `VAPID_SUBJECT` | Opcional. Contato do VAPID (`mailto:` ou `https:`). Padrão: o endereço do site. |
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
- `aparelhos`: navegadores que já entraram em cada conta (aviso de entrada nova). `id`, `usuarioId`,
  `aparelhoHash` (sha256 do id do cookie `sd_aparelho`; único por conta), `criadoEm`, `vistoEm`. Sai depois de
  400 dias sem uso e com a conta.
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
- Aparelho: cookie `sd_aparelho` = `v1.<id>.<assinatura>` (id aleatório de 128 bits, HMAC com a chave derivada da
  `SOBEDESCE_KEY`), `httpOnly`, `sameSite=lax`, 400 dias. Só identifica o navegador (`web/src/lib/auth/aparelho.ts`).
  Entrar (senha ou Google) num aparelho que a conta não tem em `aparelhos` → grava e manda "Entrada nova". Criar a
  conta, refazer a senha pelo link e `/api/eu` com o cookie do site gravam sem avisar. Sem chave, o login segue sem
  o cookie e sem o aviso.

## 5. API (JSON, `Cache-Control: no-store`)

Todas aceitam cookie (`sd_sessao`) ou Bearer de dispositivo, salvo onde dito.
Erro: `{ "erro": "<codigo>", "mensagem": "<texto para a tela>" }` com o status HTTP.
Códigos comuns: `401 sem_sessao`, `403 origem` (cookie sem Origin do site), `400 entrada` (corpo ruim).

| Método e caminho | Entrada | Saída |
|---|---|---|
| `GET /api/eu` | | `200 { usuario: { id, email, nome }, contas: Conta[], recursos: { referencias } }` · `401 { erro: "sem_sessao" }` |
| `GET /api/drive/contas` | | `200 { contas: Conta[] }` |
| `POST /api/drive/token` | `{ conta: "<id>", renovar?: boolean }` | `200 { accessToken, expiraEm (ms epoch), email }` · `404 nao_encontrada` · `409 { erro: "reconectar", mensagem }` · `502 google` · `503 sem_config` |
| `POST /api/dispositivo/iniciar` | `{ nome, plataforma }` (sem sessão; `plataforma` fora de mac/windows/linux vira null) | `200 { codigo, segredo, url, intervalo: 3, expiraEm }` · `429 devagar` |
| `POST /api/dispositivo/aguardar` | `{ segredo }` (sem sessão) | `202 { estado: "pendente" }` · `200 { estado: "pronto", token: "sdd_...", usuario }` (uma vez só) · `410 { erro: "expirado" }` (vencido, cancelado, já usado ou segredo desconhecido) · `429 devagar` (menos de 2 s desde a consulta anterior; `Retry-After: 3`) |
| `POST /api/dispositivo/sair` | Bearer | `204` (revoga a própria sessão) |
| `GET /api/google/conectar?modo=vincular\|entrar&volta=/conta` | | 302 para o Google (state + PKCE em cookie assinado de 10 min) |
| `GET /api/google/callback` | | 302 para `volta` com `?google=ok` ou `?erro=<codigo>` |

`Conta = { id, email, nome, fotoUrl, estado: "ok" | "reconectar" }`. Nunca sai token de refresh.

Referências (coleções, fila do computador, Atalho do iPhone e o link pra IA em `/r/<token>`): contrato próprio em
[REFERENCIAS.md](REFERENCIAS.md). `recursos` diz o que a conta usa (`web/src/lib/recursos.ts`: beta aberto por
`SOBEDESCE_BETA_ABERTO`, padrão ligado; fechado, vale `usuarios.plano` ou ser admin).

Erros que o callback devolve em `?erro=` (textos em `web/src/components/conta/mensagens.ts`):
`google_recusado` (access_denied), `google_sem_conta` (entrar com conta Google não vinculada: vai para
`/entrar`), `google_outra_conta` (a conta Google já é de outro usuário; nada é gravado nem revogado),
`google_nao_e_login` (a conta Google está conectada como Drive, mas não é o Google de entrar daquela conta:
não entra e nada é gravado), `google_sem_drive` (desmarcou o Drive no consentimento), `google_expirou` (cookie/state vencido ou
trocado), `google_erro`, `google_config`. "Entrar com Google" (pelo Google de entrar) também renova os tokens guardados
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
  senha nova, conta apagada (confirmação) e os avisos de segurança (`web/src/lib/email/avisos.ts`):
  - **Entrada nova** (aparelho que a conta não usou, por senha ou Google): quando, navegador e sistema
    resumidos do user-agent, cidade e país aproximados (`x-vercel-ip-city`/`x-vercel-ip-country`, só na Vercel),
    como entrou e o botão "Não fui eu" → `/conta?aviso=nao-fui-eu` (passo a passo: trocar a senha encerra tudo).
  - **Senha trocada**, **refeita pelo link** ou **criada** (conta só-Google): "Não fui eu" → `/esqueci-a-senha`.
  - **Google de entrar trocado** ou **removido** (desligado em Sua conta ou junto com o Drive).
  - **Computador conectado** (nome, sistema, quando e o lugar aproximado do pedido).
  - **Muitas senhas erradas**: a conta bateu em `loginConta`; no máximo um por conta a cada 24 h
    (`aviso-tentativas:<usuario>` em `tentativas`).
  Nenhum aviso lança: erro de banco ou do Resend vira uma linha de log, e sem `RESEND_API_KEY` em produção nada
  sai. Nunca levam IP, token, senha ou link com segredo.

## 9. Acompanhar pelo celular

O app de computador conta à conta como andam as transferências dele; o app do celular mostra ("No computador") e o
site avisa por Web Push quando um lote termina. Código: `web/src/lib/acompanhar/` (formato, status, push) e
`src/engine/acompanhar.js` (desktop).

| Método e caminho | Quem | Entrada | Saída |
|---|---|---|---|
| `POST /api/dispositivos/status` | só Bearer de dispositivo (cookie → `403 so_computador`) | `StatusComputador` (até 64 KB; maior → `413 grande_demais`; formato ruim → `400 entrada`) | `200 { ok, avisados }` |
| `DELETE /api/dispositivos/status` | só Bearer de dispositivo | | `204` (ajuste desligado: o retrato some) |
| `GET /api/transferencias` | cookie ou Bearer | | `200 { ok, agora, onlineMs, computadores: [{ id, nome, plataforma, online, atualizadoEm, snapshot }], push: { ativo, chavePublica } }` |
| `POST /api/push/inscricao` | cookie (com Origin) ou Bearer | `PushSubscription.toJSON()` = `{ endpoint, keys: { p256dh, auth } }` | `201 { ok }` · `400 entrada` |
| `DELETE /api/push/inscricao` | cookie (com Origin) ou Bearer | `{ endpoint }` | `200 { ok, apagou }` |

```
StatusComputador = {
  v: 1, estado: 'enviando'|'baixando'|'pausado'|'parado'|'concluido'|'erro',
  rodada: string|null,            // rodada de trabalho: começa quando algo anda depois de tudo parado
  geral: { feitoBytes, totalBytes, feitos, total, erros, velocidade, eta: s|null,
           sobe: { arquivos, velocidade }, desce: { arquivos, velocidade }, fora? },   // fora = ativos fora da lista
  itens: [{ id, nome, direcao: 'sobe'|'desce', feito, total|null, velocidade,
            estado: 'enviando'|'baixando'|'conferindo'|'na_fila'|'esperando'|'pausado', destino?, erro?, lote? }],  // ≤ 60 (o app manda ≤ 50)
  terminados: [{ nome, direcao, total|null, terminouEm (ms), ok, erro?, lote? }],   // ≤ 40 (o app manda os 30 últimos de 7 dias)
  lotes?: [{ id, titulo, direcao: 'sobe'|'desce'|'misto', destino?, arquivos, bytes, feitoBytes, andando, esperando,
             naFila, pausados, concluidos, cancelados, erros, conferidos, divergentes, velocidade, eta|null,
             criadoEm, terminouEm|null }],   // ≤ 20 (o app manda ≤ 15): os pedidos, como a tela Transferências
  fechado?: true,                 // última notícia antes de o app fechar
}
```

- **Banco:** `dispositivo_status` (`sessaoId` pk → `sessoes` em cascata, `usuarioId`, `snapshot` jsonb, `avisado`,
  `atualizadoEm`) e `push_inscricoes` (`id`, `usuarioId`, `endpoint` único, `keys` jsonb, `criadoEm`, `ultimoEnvioEm`,
  `falhas`). Migração `0003_acompanhar` (só acrescenta).
- **Online:** notícia nos últimos 2 min e sem `fechado`. A lista só traz sessões válidas (não revogadas, não vencidas).
- **Guarda:** só o último retrato de cada computador. Sem notícia há 7 dias → apagado (na leitura da conta e, a cada
  10 min, numa limpeza geral no POST). Revogar a sessão (desconectar, trocar/redefinir a senha) apaga junto; apagar a
  conta apaga em cascata.
- **Avisos:** quando um POST chega com `estado` `concluido` ou `erro`, `rodada` e `total > 0`, o servidor troca
  `avisado` para `"<rodada>:<estado>"` só se for diferente (um UPDATE condicional: dois pedidos juntos viram um aviso).
  Quem trocou manda o push para todas as inscrições da conta: `{ titulo, corpo, url: '/app/#computador', tag }`, ex.
  "Pronto" / "8 arquivos enviados do MacBook de Victor · 412 GB" (baixados no / transferidos no) e "Parou com erro" /
  "2 arquivos não passaram no MacBook de Victor. 6 de 8 prontos.". Resposta 404/410 → inscrição apagada; outras
  falhas somam `falhas` (10 seguidas → apagada). Até 20 inscrições por conta (as mais antigas saem).
- **Inscrição:** só endereços https de serviços de push conhecidos (`*.push.apple.com`, `fcm.googleapis.com`,
  `android.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`): o servidor faz POST para lá.
  O mesmo endereço em outra conta passa para a conta nova.
- **Sua conta:** no Início, o bloco "Computadores" mostra a porcentagem do que está passando e leva para `/app/#computador`.

## 10. Uso da plataforma (admin)

O admin (`/admin`, só para `SOBEDESCE_ADMINS`; ver `web/src/lib/admin.ts`) mostra como a plataforma está sendo usada.
Só números e datas: nunca nome de arquivo, pasta ou conta do Drive de quem transfere.

- **Dia de uso:** `atividade_diaria` (pk `usuarioId` + `dia`, no fuso de Fortaleza; `site`, `celular`, `computador`,
  `ultimaEm`, `ultimaOrigem`). Gravada em `autenticar` junto com o `ultimoUsoEm` da sessão (a cada 10 min e na virada do
  dia). Origem: Bearer = computador; cookie com `x-sobedesce-app: celular` (o `/app` manda) = celular; senão site.
- **Versão do app:** o app de computador manda `x-sobedesce-build: <n>` em todo pedido (`src/google/cloud-auth.js`); vai
  para `sessoes.appBuild`. Sem o cabeçalho (app antigo) fica `null` e conta como desatualizado.
- **Números do dia:** `POST /api/dispositivos/uso` (só Bearer de dispositivo; cookie → `403 so_computador`; até 8 KB;
  formato ruim → `400 entrada`) com `{ dias: [{ dia: 'AAAA-MM-DD', enviadosBytes, baixadosBytes, enviados, baixados, erros,
  maiorArquivo, msAtivo }] }` (≤ 14 dias). Grava em `uso_diario` (pk `sessaoId` + `dia`) o maior valor de cada campo:
  mandar de novo não soma. Dias fora de hoje −16 / +2 são ignorados. O app (`src/engine/uso.js`) conta o que terminou com
  ele aberto (uma vez por arquivo), soma o tempo com algo correndo, guarda em `uso.json` e manda ~1 min depois de abrir,
  a cada 15 min quando mudou e ao fechar.
- **Avisos por e-mail aos admins** (`web/src/lib/email/admin.ts`): conta nova (e-mail e senha ou Google) e, quando a
  soma de erros da pessoa no dia passa de 10, "Transferências com erro". Cada aviso tem uma chave em `avisos_admin`
  (`conta:<id>`, `erros:<id>:<dia>`) e sai uma vez só.
- **Tela:** online agora (uso nos últimos 15 min ou app com notícia em 2 min), ativas hoje / 7 / 30 dias, paradas há
  14+ dias, gráfico de 30 dias, volume, erros, velocidade média, maior arquivo, funil (conta → Drive → computador →
  transferiu), computadores com build (desatualizado = abaixo do `/baixar/versao`), avisos no celular, referências,
  filtros, ordem, busca e CSV (`/admin/csv`, com as mesmas opções; células que começam com `= + - @` levam `'`).
  `/admin/pessoa/<id>`: Drives, aparelhos com **Desconectar** (`revogarSessaoDe`), dia a dia dos últimos 60 dias e
  linha do tempo (conta, Drives, computadores, último login).
- **Guarda:** `atividade_diaria` e `uso_diario` ficam 400 dias (limpeza de carona em `sessao.ts`); `uso_diario` some com
  a sessão; tudo some com a conta. Migração `0006_uso_admin` (só acrescenta).

## 11. Gerar proxy pelo celular

O celular não gera vídeo: ele pede, e o app SOBEDESCE de um computador com a mesma conta gera. Mesmo esquema da fila
das Referências (pegar de uma vez só, sinal de vida, preso volta para a fila).

- **Banco:** `pedidos_proxy` (`usuarioId`, `contaGoogleId`, `fileId`, `nome`, `tamanho`, `status` = `pendente` |
  `gerando` | `pronto` | `erro`, `erro`, `resultado`, `proxyFileId`, `dispositivoId`, datas). Migração
  `0007_pedidos_proxy` (só acrescenta). Some com a conta e com a conta Google (cascade).
- **API** (`web/src/app/api/proxies/pedidos/`; cookie ou Bearer; respostas `{ ok, ... }`):
  - `GET ?status=pendente[,…]|todos&fileIds=a,b` → `{ pedidos }` (mais novos primeiro; até 500). Antes de listar,
    `gerando` sem notícia há 30 min volta a `pendente` e terminados com mais de 14 dias somem.
  - `POST { contaGoogleId, itens: [{ fileId, nome, tamanho? }] }` (até 200) → `{ pedidos, novos }` (201 se entrou algum).
    Conta Google de outra pessoa → `404 conta`. O mesmo arquivo já `pendente`/`gerando` não entra de novo.
  - `POST /:id/pegar` (só Bearer; cookie → `403 so_computador`) → `{ pedido }`; outro computador já pegou → `409 ocupado`.
  - `PATCH /:id { status, erro?, resultado?, proxyFileId? }`: o computador que pegou muda tudo (`gerando` = sinal de
    vida); o dono pelo celular só devolve para `pendente` (tentar de novo um erro). `pronto` não volta.
  - `DELETE /:id` cancela.
- **Computador** (`src/engine/pedidos-proxy.js`): com a conta SOBEDESCE e o conversor (ffmpeg), a cada 30 s pega os
  pendentes, um por vez, na ordem em que o celular pediu. Gera como o "Gerar proxy" da tela Drive (`gerarPreviasLote`
  só com aquele arquivo, `forcar`, `baixar`: usa o original que a fila conhece ou baixa do Drive) e conta `pronto`
  (`proxyFileId`; "Já tinha proxy" quando já existia) ou `erro` (frase curta). Sinal de vida a cada 5 min; 404/409 no
  sinal (cancelado no celular, outro pegou) para no meio. Fechar o app devolve o pedido para `pendente`. Sem conversor,
  não pega nada (outro computador da conta pode ter).
- **Tipos** (`tipo`, migração `0008_pedidos_tipo`): `proxy` (padrão; o que os apps antigos pegam), `frames`
  (docs/FRAMES.md, `ajustes` dos frames e takes) e `formato` ("Baixar como…" das Referências, `ajustes: { formato }`
  com `mp4`, `mp4-1080`, `mp4-720`, `mp3-320`, `wav`, `m4a` ou `jpg`; até 20 por vez; o mesmo arquivo pode ter um
  pedido esperando por formato; computador: `src/referencias/pedidos-formato.js`, docs/REFERENCIAS.md §7). `GET`
  sem `tipo` lista só `proxy`; `?tipo=frames|formato|todos`.
- **Celular** (`components/proxies.js`): na seleção da aba Drive, **Gerar proxy** (só vídeos, inclusive RAW de câmera;
  não as próprias cópias leves). A folha diz se há um computador ligado (pela notícia do "Acompanhar pelo celular"),
  pede e acompanha cada vídeo a cada 5 s enquanto está aberta: esperando, gerando, pronto ou o erro com **De novo**.
