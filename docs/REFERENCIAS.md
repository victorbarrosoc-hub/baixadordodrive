# Referências: contrato

Biblioteca de referências no estilo “Salvos” do Instagram, guardada no Google Drive da própria pessoa.
Este documento é a fonte da verdade entre o **site** (`web/`, API e página pública), o **celular** (`web/public/app/`)
e o **computador** (app Electron, que baixa). Mudou algo aqui? Avise as outras frentes.

```
celular / Atalho do iPhone ──POST link──▶ fila no site ◀──GET/pegar/PATCH── app do computador (navegador + yt-dlp)
                                                                                   │ sobe o vídeo
                                                    Drive: SOBEDESCE Referências/<Coleção>/arquivo
página pública /r/<token> (HTML, .json, .md) ◀── lê a pasta pelo servidor ──────────┘
```

## 1. Quem usa

- `usuarios.plano`: `gratis` (padrão) · `pro` · `produtora`. Troca em `/admin` (só admin).
- `podeUsar(usuario, recurso)` (`web/src/lib/recursos.ts`):
  - **Beta aberto** (`SOBEDESCE_BETA_ABERTO`, padrão ligado; `0`/`false`/`off`/`nao` fecham): toda conta logada usa tudo.
  - Beta fechado: Referências = plano `produtora` **ou** admin (`web/src/lib/admin.ts`, `ehAdmin`).
- Sem o recurso, toda rota daqui responde `403 { ok: false, erro: "plano", motivo: "plano", mensagem }`.
  Com o beta aberto ninguém vê isso.
- `GET /api/eu` ganhou `recursos: { referencias: boolean }`.

## 2. Banco (migração `web/drizzle/0002_referencias.sql`, só acréscimos)

| Tabela | Colunas |
|---|---|
| `colecoes` | `id`, `usuarioId` (fk, cascade), `contaGoogleId` (fk `contas_google`, cascade), `driveFolderId`, `nome`, `nomeChave` (nome sem maiúsculas/acentos; único por usuário), `publicaToken` (único, 32 bytes base64url; null = link desligado), `criadoEm`, `atualizadoEm` |
| `referencias_fila` | `id`, `usuarioId` (fk, cascade), `colecaoId` (fk, cascade), `url`, `nota`, `status` (`pendente`·`baixando`·`pronto`·`erro`), `erro`, `driveFileId`, `dispositivoId` (sessão do computador que pegou), `criadoEm`, `atualizadoEm` |
| `atalhos` | `id`, `usuarioId` (fk, cascade), `tokenHash` (sha256, único), `criadoEm`, `ultimoUsoEm`, `revogadoEm` |
| `usuarios.plano` | `text not null default 'gratis'` |
| `contas_google.referenciasPastaId` | id da pasta “SOBEDESCE Referências” daquele Drive (achada ou criada na primeira coleção) |

## 3. API (JSON, `Cache-Control: no-store`)

Autenticação: cookie `sd_sessao` (site/celular; mutações conferem `Origin`) **ou** `Authorization: Bearer sdd_…`
(computador, sem Origin). Sucesso: `{ ok: true, … }`. Erro: `{ ok: false, erro, mensagem }` com o status HTTP.
Erros comuns: `401 sem_sessao`, `403 origem`, `403 plano`, `400 entrada`, `409 reconectar` (o Google pediu para
reconectar aquele Drive), `502 google`.

```ts
Colecao = { id, nome, contaGoogleId, driveFolderId, link: string | null /* https://sobedesce.com/r/<token> */,
            naFila: number /* pendente + baixando + erro */, criadoEm, atualizadoEm }   // datas em ISO
ItemFila = { id, url, plataforma /* "Instagram" | "YouTube" | … | domínio */, nota, status, erro, driveFileId,
             dispositivoId, colecao: { id, nome, driveFolderId, contaGoogleId }, criadoEm, atualizadoEm }
```

| Método e caminho | Entrada | Saída |
|---|---|---|
| `GET /api/referencias/colecoes` | | `{ ok, raiz: { contaGoogleId, driveFolderId } \| null, raizes: [mesmo formato, uma por Drive], colecoes: Colecao[] }` (mais novas primeiro) |
| `POST /api/referencias/colecoes` | `{ nome, contaGoogleId? }` | `201 { ok, colecao }` · `400 nome` · `404 nao_encontrada` (Drive que não é da pessoa) · `409 duplicada` · `409 sem_drive` |
| `PATCH /api/referencias/colecoes/:id` | `{ nome?, link?: "ligar" \| "desligar" \| "trocar" }` | `{ ok, colecao }` · `404` · `409 duplicada` |
| `DELETE /api/referencias/colecoes/:id[?apagarNoDrive=1]` | | `{ ok, apagadaNoDrive }` (sem o parâmetro a pasta fica no Drive; com ele vai para a lixeira) |
| `POST /api/referencias/fila` | `{ url, colecaoId, nota? }` | `201 { ok, item, novo: true }` · mesmo link já `pendente`/`baixando` na mesma coleção: `200 { ok, item, novo: false }` · `400 url` · `404` |
| `GET /api/referencias/fila` | `?status=pendente` (vírgulas; `todos`), `?colecao=<id>` | `{ ok, itens: ItemFila[] }` (mais novos primeiro; sem `status`: pendente, baixando e erro) |
| `POST /api/referencias/fila/:id/pegar` | (só Bearer) | `{ ok, item }` (agora `baixando`, `dispositivoId` = este computador) · `409 ocupado` · `404` · cookie: `403 so_computador` |
| `PATCH /api/referencias/fila/:id` | `{ status, driveFileId?, erro? }` | `{ ok, item }` · regras abaixo |
| `DELETE /api/referencias/fila/:id` | | `{ ok }` (cancela) |
| `GET /api/referencias/atalho/token` | (só cookie) | `{ ok, ativo, criadoEm, ultimoUsoEm }` |
| `POST /api/referencias/atalho/token` | (só cookie) | `201 { ok, token: "sda_…", endpoint, instalar: "https://sobedesce.com/atalho#chave=sda_…", criadoEm }` (o valor aparece só aqui; a chave anterior para de valer) |
| `DELETE /api/referencias/atalho/token` | (só cookie) | `{ ok, ativo: false }` |
| `POST /api/referencias/atalho` | `Authorization: Atalho sda_…` + JSON, formulário ou o link puro como texto: `{ url, colecao?: nome ou id, nota? }` | `201 { ok, mensagem: "Salvo em X. O computador baixa.", colecao, item: { id, status } }` · já na fila: `200` · `401 chave` · `404 colecao` (a mensagem lista as coleções) · `409 sem_colecao` · `429 devagar` |

**Links.** A API aceita texto com o link no meio (`"Olha https://…"`), troca `http` por `https`, tira `#…` e
parâmetros de rastreio (`utm_*`, `igsh`, `igshid`, `si`, `fbclid`, `feature`…) e recusa o que não for https público
ou passar de 2048 caracteres. A URL guardada (e entregue ao computador) é a limpa.

**Fila: quem muda o quê.**
- O computador que pegou (`status = baixando` e `dispositivoId` = a sessão dele):
  `pronto` (exige `driveFileId`), `erro` (com `erro`, até 500 caracteres), `pendente` (devolve) ou `baixando`
  (**sinal de vida**: mande a cada 5 min num download longo).
- O dono pelo site/celular: só `pendente` (tentar de novo um `erro`, ou soltar um item preso). Cancelar = `DELETE`.
- Outro computador da conta: `409 ocupado`. Item `pronto` não volta.
- `baixando` sem notícia há **30 min** volta a ficar livre: aparece de novo em `?status=pendente` e outro computador
  pode pegar. Pegar é atômico (dois pedidos juntos: um leva `200`, o outro `409`); o mesmo computador pedindo de
  novo recebe `200` (repetição segura depois de queda de rede).
- Itens `pronto` saem da fila 30 dias depois (o arquivo continua no Drive).

**Fluxo do computador.** `GET /api/referencias/fila?status=pendente` (a cada ~30 s com o app aberto) → para cada
item, `POST …/pegar` → baixa → sobe para `item.colecao.driveFolderId` com o Drive `item.colecao.contaGoogleId`
(`nuvem:<id>` no AuthManager) e os metadados do §4 → `PATCH { status: "pronto", driveFileId }`. Falhou:
`PATCH { status: "erro", erro: "<texto curto para a pessoa>" }`. Para criar coleções o computador usa as mesmas rotas.

## 4. O arquivo no Drive (escrito pelo computador)

Pasta: `SOBEDESCE Referências/<Coleção>/` (a raiz tem `appProperties { sobedesce: "referencias" }`, cada coleção
`{ sobedesce: "colecao" }`; a pasta certa é sempre `colecao.driveFolderId`, mesmo se a pessoa mover ou renomear).

`appProperties` do arquivo (cada propriedade tem limite de 124 bytes somando chave e valor: corte os valores):

| Chave | Valor |
|---|---|
| `sobedesce` | `referencia` (obrigatória: é o que a página pública lista) |
| `fonte` | link original (pode vir cortado; o inteiro é a 1ª linha da descrição) |
| `plataforma` | `Instagram`, `YouTube`, `TikTok`, `Vimeo`, `Pinterest`, `X`, `Facebook` ou o domínio (em minúsculas também vale) |
| `autor` | `@perfil` ou nome do canal, curto |
| `titulo` | título curto |
| `fila` | (opcional) id do item da fila |

`description` (texto livre do Drive, lido com cuidado: qualquer linha pode faltar):

```
https://www.instagram.com/reel/C1abc/
Título: Plano-sequência no metrô
Autor: @fulano
Plataforma: Instagram
Salvo em: 2026-10-16T14:03:00Z

Legenda original do post.
Notas da pessoa (a `nota` da fila), se houver.
```

1ª linha = link original (só se começar com `http`); depois `Chave: valor` até a primeira linha em branco
(`Título`/`Titulo`, `Autor`, `Plataforma`, `Salvo em`); o resto é legenda e notas. Parser: `lerDescricao` em
`web/src/lib/referencias/texto.ts`. Nome do arquivo: o que o computador quiser (de preferência o título, com a
extensão). A miniatura é a do próprio Drive (vídeo e foto têm sozinhos).

## 5. Atalho do iPhone

- Chave `sda_` + 43 caracteres base64url. Só põe link na fila: não vale como Bearer, não lê nada, não abre a conta.
  Uma ativa por conta; gerar outra derruba a anterior. No banco só o sha256.
- Limites: 120 links por hora por chave; 20 chaves erradas em 15 min por IP (`429`).
- `/atalho#chave=sda_…`: passo a passo (o fragmento não vai para o servidor). O Atalho é montado à mão no app
  Atalhos: Folha de Compartilhamento (URLs e Texto) → **Obter Conteúdo de URL**, `POST`
  `https://sobedesce.com/api/referencias/atalho`, cabeçalho `Authorization: Atalho <chave>`, corpo JSON
  `{ url: Entrada do Atalho, colecao: "<nome>" }`. Sem `colecao`: a coleção mais recente.

## 6. Link pra IA (`/r/<token>`)

- `GET /r/<token>` (HTML claro, mínimo), `/r/<token>.json` e `/r/<token>.md`. Sem login. `X-Robots-Tag: noindex`,
  `<meta name="robots" content="noindex">`, `Cache-Control: private, no-store`, `<link rel="alternate"
  type="text/markdown">`. Token desconhecido, trocado ou desligado: `404` (na hora, em todos os formatos).
- Conteúdo: arquivos da pasta com `appProperties.sobedesce = referencia` (fora da lixeira), mais novos primeiro. Por item:
  título, plataforma, autor, link original, legenda/notas, tipo, duração, “salvo em” e o **link do vídeo no Drive
  só se o arquivo estiver aberto para quem tem o link** (`permissionIds` com `anyoneWithLink`/`anyone`, também
  herdado da pasta). Nunca o e-mail do dono: só o primeiro nome (“Referências salvas por Victor na SOBEDESCE.”).
- Cache em memória de 5 min por link (o banco é consultado sempre, então desligar vale na hora). Drive fora do
  ar: `503` com aviso.

```jsonc
// /r/<token>.json
{ "ok": true, "colecao": "Clipes", "nota": "Referências salvas por Victor na SOBEDESCE.", "total": 2,
  "atualizadoEm": "ISO", "pastaNoDrive": "https://drive.google.com/…" | null,
  "itens": [{ "titulo", "plataforma", "autor", "url", "legenda", "tipo": "video|foto|arquivo",
              "duracaoSegundos", "drive": "https://drive.google.com/file/d/…/view" | null, "salvoEm" }] }
```

## 7. Celular (`web/public/app/`)

- Aba **Referências** (só com `recursos.referencias`). Abre por `/app/#referencias`.
- Coleções em grade (capa 2×2 com as últimas miniaturas, nome e quantidade), “Nova coleção”, “Salvar link”
  (colar da área de transferência, escolher a coleção). Dentro: grade de miniaturas (prévia e player de sempre;
  a folha mostra “Abrir no Instagram/YouTube…”, autor e legenda) e, no topo, os links esperando o computador
  (“Aguardando o computador baixar…”, ou o erro com “Tentar de novo”). Menu: Renomear, Link pra IA (ligar, copiar,
  trocar, desligar e abrir os vídeos para quem tem o link), Apagar.
- O celular lista a pasta com o token do Drive escolhido no aparelho (`lib/drive.js`). Coleção de outro Drive da
  conta: pede para trocar de Drive.
- Android: `share_target` nos dois manifestos (`GET /app/?compartilhar=1&title=&text=&url=`; o navegador pode
  trocar a query, então o app também reconhece só `url`/`text`). Abre “Salvar link” com o link achado no texto.
- iPhone: cartão “Salvar direto do Instagram” → gera a chave e leva ao `/atalho`. Fica no topo da aba (logo abaixo
  de “Procurar referência”) enquanto o atalho não está ligado; ligado, vai para o pé da página (2.8.2).
- **Procurar referência (2.8.2)**, o “Abrir navegador” do computador no celular: o app não mostra o Instagram por
  dentro (os sites bloqueiam), então os botões Instagram, TikTok e YouTube abrem o app (ou o site) da rede em outra
  aba e guardam `{ label, em }` em `sessionStorage` (`sobedesce.refs.fora`). Ao voltar (`visibilitychange`, até 30 min
  depois), aparece “Voltou do Instagram?” no topo: **Colar** lê a área de transferência (o toque é o gesto que o iOS
  pede) e abre “Salvar link” já com o link achado; sem link, abre a folha vazia. O × descarta.
- Aviso de primeiro uso: “Salve só para referência dos seus projetos. Respeite os direitos de quem criou.”
