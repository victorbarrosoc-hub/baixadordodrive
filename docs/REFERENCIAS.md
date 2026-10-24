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
| `referencias_fila` | `id`, `usuarioId` (fk, cascade), `colecaoId` (fk, cascade), `url`, `nota`, `status` (`pendente`·`baixando`·`pronto`·`erro`), `erro`, `driveFileId`, `dispositivoId` (sessão do computador que pegou), `formatos` (jsonb, "Também salvar como"; migração `0012_referencias_formatos`), `criadoEm`, `atualizadoEm` |
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
             dispositivoId, formatos: Formato[] /* "Também salvar como"; [] = só o original */,
             colecao: { id, nome, driveFolderId, contaGoogleId }, criadoEm, atualizadoEm }
Formato = "mp4" | "mp4-1080" | "mp4-720" | "mp3-320" | "wav" | "m4a" | "jpg"   // o original sempre vai
```

| Método e caminho | Entrada | Saída |
|---|---|---|
| `GET /api/referencias/colecoes` | | `{ ok, raiz: { contaGoogleId, driveFolderId } \| null, raizes: [mesmo formato, uma por Drive], colecoes: Colecao[] }` (mais novas primeiro) |
| `POST /api/referencias/colecoes` | `{ nome, contaGoogleId? }` | `201 { ok, colecao }` · `400 nome` · `404 nao_encontrada` (Drive que não é da pessoa) · `409 duplicada` · `409 sem_drive` |
| `PATCH /api/referencias/colecoes/:id` | `{ nome?, link?: "ligar" \| "desligar" \| "trocar" }` | `{ ok, colecao }` · `404` · `409 duplicada` |
| `DELETE /api/referencias/colecoes/:id[?apagarNoDrive=1]` | | `{ ok, apagadaNoDrive }` (sem o parâmetro a pasta fica no Drive; com ele vai para a lixeira) |
| `POST /api/referencias/fila` | `{ url, colecaoId, nota?, formatos? }` | `201 { ok, item, novo: true }` · mesmo link já `pendente`/`baixando` na mesma coleção: `200 { ok, item, novo: false }` (formatos novos somados enquanto `pendente`) · `400 url` · `400 entrada` (formato desconhecido) · `404` |
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
| `celular` | `ok` quando o computador já conferiu que o vídeo toca no iPhone (ou já converteu); ver abaixo |

**Convertidos ("Baixar como…", §7).** Ficam na mesma pasta, ao lado do original, com o nome dele mais o formato
(`<nome do original> (MP3 320).mp3`, `(WAV).wav`, `(M4A).m4a`, `(MP4 720p).mp4`, `(JPG).jpg`), a mesma `description`
e `appProperties` `{ sobedesce: "formato", formato, de: <id do original>, plataforma, autor, titulo, fonte }`. Como
não são `sobedesce=referencia`, não entram no link pra IA nem na passada do celular.

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

**Vídeo que toca no iPhone** (`src/referencias/celular.js`). O Safari do iPhone não toca VP9 nem AV1 dentro de MP4,
e é assim que o Instagram manda boa parte dos reels nos formatos separados (vídeo + áudio). Por isso:

- O formato pedido ao yt-dlp (`formato()` em `src/referencias/ytdlp.js`) vai, nesta ordem:
  - H.264 separado (o YouTube);
  - o progressivo MP4 que toca no iPhone (Instagram e TikTok; o Instagram não informa o codec dele, e é H.264);
  - um MP4 separado que toca;
  - só no fim VP9/AV1.
- Se ainda assim vier VP9/AV1/VP8, o computador converte para H.264 + AAC antes de subir (até 1920 px no lado maior,
  ~2,5 Mbit/s, `+faststart`), com o ffmpeg da prévia leve. Na tela aparece "Convertendo para tocar no celular".
  Sem ffmpeg com H.264, sobe como veio.
- As referências salvas antes disso passam por uma **passada única** em segundo plano, ~2 min depois de abrir o app
  com a conta conectada:
  - só os vídeos com `sobedesce=referencia`, sem `celular=ok` e até 400 MB;
  - um por vez: baixa, olha o codec e, se precisar, troca o conteúdo do **mesmo arquivo** (mesmo id, link, nome,
    descrição e coleção; o Drive guarda a versão anterior por 30 dias);
  - tudo o que é conferido ganha `celular=ok`, e não é olhado de novo nem em outro computador;
  - terminou sem falhas: o ajuste `referenciasCelular` fica `true`. Um arquivo que falhar volta na próxima abertura.
- O celular, diante de um vídeo de referência sem `celular=ok` que não toca, explica que o app do computador converte
  sozinho (em vez do aviso genérico de formato) e oferece **Tocar pelo Drive**: o player do Drive
  (`drive.google.com/file/d/<id>/preview`, em tela cheia) toca qualquer formato, porque o Google converte. Ele só abre
  dentro do app com o link liberado. A pessoa confirma e escolhe **Liberar a coleção** (a pasta da coleção: as
  referências dela, inclusive as próximas, herdam) ou **Só este vídeo** ("qualquer pessoa com o link", leitor, sem
  aparecer em buscas). Com o link já liberado, a referência abre direto no player do Drive. Sem permissão de
  compartilhar, fica só o aviso. `web/public/app/components/preview.js` (`RefLiberar`).

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
  de “Procurar referência”) até o atalho salvar o primeiro link (`ativo` e `ultimoUsoEm`; só a chave gerada não
  basta, o atalho pode nunca ter sido montado); depois vai para o pé da página (2.8.3).
- **Procurar referência (2.8.2)**, o “Abrir navegador” do computador no celular: o app não mostra o Instagram por
  dentro (os sites bloqueiam), então os botões Instagram, TikTok e YouTube abrem o app (ou o site) da rede em outra
  aba e guardam `{ label, em }` em `sessionStorage` (`sobedesce.refs.fora`). Ao voltar (`visibilitychange`, até 30 min
  depois), aparece “Voltou do Instagram?” no topo: **Colar** lê a área de transferência (o toque é o gesto que o iOS
  pede) e abre “Salvar link” já com o link achado; sem link, abre a folha vazia. O × descarta.
- **Coleção na hora de salvar (2.8.10):** em “Salvar link”, a lista de coleções termina em **+ Nova coleção** e cada
  coleção tem um lápis para **renomear**. Os dois abrem um campo na própria linha (Criar/OK, × ou Esc cancela), sem
  sair da folha nem perder o link colado; a coleção criada já fica escolhida.
- **Links públicos com o domínio (2.8.10):** o link pra IA e os endereços do atalho saem sempre com o endereço
  principal (`origemPublica` em `lib/site.ts`), mesmo quando o pedido vem do endereço antigo (`sobedesce.vercel.app`,
  app instalado na Tela de Início antes do domínio). Os links antigos continuam abrindo: o token é o mesmo.
- Aviso de primeiro uso: “Salve só para referência dos seus projetos. Respeite os direitos de quem criou.”

## 7. Formatos: "Baixar como…" e "Também salvar como"

Pedido do dono do produto: depois de salvar, baixar a referência em outros tipos (ex.: MP3 320 kbps).

- **Formatos** (`src/referencias/formatos.js`): vídeo original (como hoje); **MP4** H.264 + AAC (melhor disponível,
  1080p ou 720p, pelo lado menor: vertical 1080 × 1920 já é 1080p); só áudio **MP3 320** (libmp3lame, 320 kbps CBR),
  **WAV** (PCM 16 bits, 48 kHz) e **M4A** (o AAC do vídeo copiado sem perda; outro codec vira AAC 256k); foto/carrossel:
  original ou **JPG** (JPEG vai como está; WebP/PNG/AVIF viram JPEG).
- **De onde vem o arquivo:** nunca da plataforma de novo. Na hora de salvar, do vídeo que o yt-dlp acabou de baixar
  (um vínculo dele em `<dados>/referencias/formatos/<id>/`). Depois, do original da coleção no Drive (baixado uma vez:
  outro formato do mesmo arquivo em 10 min usa o mesmo). Quem converte é o ffmpeg do app (o da prévia leve). H.264 +
  AAC que já cabe no pedido só troca o contêiner (sem perda, na hora); o resto converte (libx264 CRF 18, ou o
  codificador de vídeo da máquina).
- **Destino:** a coleção (ao lado do original, envio normal pela fila de Transferências) e/ou uma pasta do
  computador (a mesma "Para" da prévia, Downloads por padrão; nome repetido ganha "(2)").
- **Computador:** cada item da coleção tem **Baixar como…** (botão no cartão, botão direito e na prévia): onde
  (Computador, Coleção ou Os dois) e o formato. "Salvar referência" ganha **Também salvar como** (pílulas, várias).
  O andamento aparece em "Salvando agora" (Barra) e no Destaque do lado; erros com frase curta ("Este vídeo não tem
  áudio.", "Para converter, falta o ffmpeg neste computador.", "O ffmpeg deste computador não gera MP3."). A última
  escolha fica lembrada (formato por tipo de arquivo, destino e os "também").
- **Rotas locais:** `POST /api/referencias/exportar { colecaoId, fileId, formato, destino: "computador"|"drive"|"ambos",
  destDir? }` → `{ trabalho }` (tipo `formato`); `GET /api/referencias/conversor` → `{ conversor: { ok, mp3, h264,
  aviso, formatos } }`; `POST /api/referencias/salvar` e `…/salvar-imagem` aceitam `formatos`.
- **Celular** (o celular não converte vídeo): em "Salvar link", **Também salvar como** vai no item da fila
  (`formatos`) e o computador salva os convertidos junto do original. Na prévia de uma referência, **Baixar como…**
  abre ali mesmo o formato e **Pedir ao computador**: vira um pedido `tipo: "formato"`, `ajustes: { formato }` em
  `/api/proxies/pedidos` (docs/CONTAS.md §11); o app do computador (mesma conta, aberto, com ffmpeg) converte e salva
  ao lado do original na coleção, e o celular salva no aparelho por lá. O estado do pedido (esperando, convertendo,
  pronto, erro com Tentar de novo) aparece no mesmo bloco. Sem o computador ligado, o pedido espera.
