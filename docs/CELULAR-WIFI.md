# Celular ↔ computador pelo Wi-Fi

O celular (app em `/app/`, com a conta) e o app do computador da **mesma conta** trocam arquivos direto pela rede de
casa ou do escritório, como o AirDrop: sem QR code, sem passar pela internet e sem subir pro Drive. Nos dois sentidos.

- **Celular → computador:** o arquivo fica só no computador, na pasta "SOBEDESCE do celular" (Ajustes, padrão em
  Downloads). O computador aceita sozinho: é a mesma conta.
- **Computador → celular:** o celular precisa estar com o app aberto. Aparece "MacBook de Victor quer mandar 3
  arquivos" com Aceitar; depois, cada arquivo tem Salvar (Fotos ou Arquivos, pela folha de compartilhar do sistema).
- Fora da mesma rede não funciona (é a escolha: rápido e direto). A tela diz "Confira se os dois estão no mesmo Wi-Fi".

O modo antigo "Receber do celular (mesmo Wi-Fi)" com QR code (`src/mobile/receiver.js`, docs/CELULAR.md) continua:
serve para quem não tem conta no celular e sobe pro Drive.

## Como funciona

A página do app no celular é HTTPS e não pode falar com `http://192.168.x.x` (conteúdo misto). Por isso a conexão é
**WebRTC** (canal de dados), que funciona entre uma página HTTPS e um aparelho da rede local:

1. **Sinalização pelo site** (`/api/p2p/*`): cada aparelho fica numa espera longa (`GET /api/p2p/espera`, até 25 s)
   enquanto está aberto; isso também marca que ele está online e em qual rede (HMAC do IP público, como em
   `lib/lan/presenca.ts`). Quem vai mandar cria a **oferta** (SDP inteira, sem trickle) e manda pelo site; o outro
   responde com a **resposta**. O site só repassa: sinais valem 2 minutos e só entre aparelhos da mesma conta.
2. **Conexão direta:** o computador anuncia o IP local de verdade (o app desliga a ofuscação mDNS do Chromium:
   `--disable-features=WebRtcHideLocalIpsWithMdns`). O Safari anuncia um nome `.local`, mas manda as checagens de
   conexão para o IP do computador, e o computador aprende o endereço do celular por elas (candidato
   peer-reflexivo). Sem servidor STUN/TURN: só a rede local. Rede de visitantes com isolamento entre aparelhos não
   deixa conectar.
3. **Protocolo do canal** (`web/public/app/lib/p2p-canal.js`, cópia idêntica em `public/celular/p2p-canal.js`): quem
   cria a oferta é sempre quem manda. Lista → pode/não → arquivo a arquivo em pedaços de 64 KiB → guardado → acabou.
   Controle de fluxo por confirmações (no máximo 16 MiB adiantados). O canal é cifrado (DTLS) pelo próprio WebRTC.

No computador, o WebRTC roda numa **janela oculta** do Electron (`desktop/main.js` → `public/celular/p2p.html`), que
existe enquanto o app está aberto (no Mac, mesmo com a janela principal fechada). Ela conversa com o motor pela API
local; o motor faz a espera longa no site, grava os arquivos e mostra o andamento na interface.

## Site (`web/`)

Tabelas (`drizzle/0011_p2p.sql`):

- `p2p_aparelhos`: `sessao_id` (PK, sessões), `usuario_id`, `tipo` (`celular` | `computador`), `nome`, `rede`,
  `visto_em`. Online = visto há menos de 70 s.
- `p2p_sinais`: `id`, `usuario_id`, `de_sessao`, `para_sessao`, `tipo` (`oferta` | `resposta` | `recusa` |
  `cancela`), `oferta` (id da oferta, nos outros tipos), `sdp`, `resumo` (`{ arquivos, bytes, nomes[≤5] }`),
  `motivo`, `criado_em`, `entregue_em`. Mais velhos que 2 min não são entregues e somem.

Rotas (cookie do site no celular; Bearer `sdd_` no computador):

| Rota | O quê |
| --- | --- |
| `GET /api/p2p/espera?nome=` | Marca online (tipo pela sessão: dispositivo = computador). Devolve `{ agora, sinais }` assim que houver sinal para esta sessão (e marca entregue), ou `[]` depois de 25 s. `curto=1`: não espera. |
| `GET /api/p2p/aparelhos` | `{ aparelhos: [{ id, nome, tipo, mesmaRede }] }`: os da mesma conta, online, do outro tipo (o celular vê computadores; o computador, celulares). |
| `POST /api/p2p/sinal` | `{ para, tipo: 'oferta', sdp, resumo }` ou `{ para, tipo: 'resposta' \| 'recusa' \| 'cancela', oferta, sdp?, motivo? }` → `{ id }`. Oferta só para aparelho online da conta; os outros só sobre uma oferta entre os dois. SDP até 20 mil caracteres. Até 20 ofertas por minuto por sessão. |

Sinal entregue: `{ id, tipo, de: { id, nome, tipo }, oferta?, sdp?, resumo?, motivo?, criadoEm }`.

## Celular (`web/public/app/`)

- `lib/p2p.js`: a espera longa (só com a conta, tela à vista), a lista de computadores, mandar e receber.
- **Início:** com computador online, o bloco "Mandar para o computador" (o nome, e "na mesma rede" quando o site sabe).
  Toque → escolher arquivos → folha com o andamento (arquivo, %, velocidade) e Cancelar.
- **Recebendo:** folha "MacBook de Victor quer mandar 3 arquivos · 1,2 GB" com Aceitar/Recusar. Os bytes vão para o
  armazenamento do app (OPFS, sem encher a memória); no fim, cada arquivo tem **Salvar** (`navigator.share` com o
  arquivo: Salvar em Fotos/Arquivos) e "Salvar todos". Sem OPFS: na memória, até 1 GB.
- O app avisa para manter a tela aberta enquanto passa (o iPhone pausa a página em segundo plano).

## Computador

- Ajustes: `celularReceber` (padrão ligado) e `celularPasta` (padrão `<Downloads>/SOBEDESCE do celular`).
- `src/celular/wifi.js` (motor): a espera longa no site enquanto há conta, as transferências e a gravação (arquivo
  `.parcial` + fsync + nome final sem colisão, como no receptor da rede). Recusa sozinho se `celularReceber` estiver
  desligado ou faltar espaço.
- `src/server/celular.js`, rotas locais:
  - `GET /api/celular` (estado: ajustes, celulares online, transferências), `POST /api/celular/aparelhos` (pede a lista ao site agora)
  - `POST /api/celular/sinal` (a janela oculta manda oferta/resposta pelo site)
  - `POST /api/celular/enviar` `{ para, caminhos }` (interface) → a janela oculta recebe `celular-enviar` pelo SSE e cria a oferta
  - `GET /api/celular/arquivo/:tid/:i` com `Range` (a janela oculta lê o que manda)
  - `POST /api/celular/receber` `{ tid, de, arquivos }` → `{ ok, motivo? }`; `PUT /api/celular/receber/:tid/:i?offset=`
    (corpo `application/octet-stream`); `POST /api/celular/receber/:tid/:i/fim`
  - `POST /api/celular/estado/:tid` (andamento e fim, nos dois sentidos) e `POST /api/celular/cancelar/:tid`
- SSE: `celular` (estado para a interface), `celular-oferta`, `celular-enviar`, `celular-sinal`, `celular-cancelar` (para a janela oculta).
- Interface: em **Dispositivos**, a seção "Celular" (celulares online, Mandar para o celular, o que está passando, a
  pasta e o ajuste). No Início, o que está chegando do celular aparece em "Em andamento".

## Testar

- `test/celular-wifi.test.js`: protocolo do canal (par de canais falsos), cópia idêntica, rotas locais e gravação.
- `web/tests/p2p.test.mts`: espera longa, presença, quem vê quem, regras dos sinais, validade e limite.
- Falta testar com aparelhos de verdade: iPhone (Safari e app na Tela de Início) e Android com Mac e Windows, numa
  rede de casa e numa rede com isolamento entre aparelhos (precisa dar a mensagem certa).
