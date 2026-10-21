# Kit visual das telas do app do computador

Todas as telas seguem o padrão de **Frames**, **Cartões** e **Início**: leitura fácil, poucas palavras, botões
grandes onde importa, números em destaque, gráficos quando há dado de verdade e movimento discreto. Peças em
`public/components/kit.js`; estilos em `public/kit.css`; o que é só de uma tela vai em `public/telas/<tela>.css`.

## As peças

| Peça | Para quê |
| --- | --- |
| `Pagina({ titulo, frase, acoes, lado, larga })` | Título grande + frase curta; `lado` = coluna da direita (360 px; `larga` 400 px), presa ao rolar. Abaixo de 1180 px vira uma coluna. |
| `Passo({ n \| icone, cor, titulo, sub, frase, acao, i })` | O bloco de cada assunto, numerado (passos de um fluxo) ou com ícone (seções sem ordem). `i` = posição na cascata de entrada. |
| `Opcoes({ valor, itens, onEscolher, colunas })` | Escolha entre poucas opções em cartões grandes com ícone, texto e o check (JPG/PNG/TIFF do Frames). |
| `Pilulas({ valor, itens, onEscolher })` | Escolha rápida/filtro em pílulas (12/24/48/96). |
| `Destaque({ titulo, numero, unidade, linha, progresso, tom, vivo })` | O cartão colorido com o número grande (resultado, total, andamento). `vivo` = brilho passando enquanto algo anda. |
| `Resumo({ titulo })` + `.k-caixa` | O painel lateral "O que vai sair" / "Agora". |
| `Stats({ itens })` | 2–4 números com ícone colorido (velocidade, arquivos, falta, erros). |
| `Barra({ p, tom, vivo })` | Progresso (null = indeterminada). |
| `Linhas` + `Linha({ titulo, sub })` | Ajustes: texto à esquerda, controle (Switch, Stepper, Select) à direita, dentro de um `Passo`. |
| `Item({ icone, tom, titulo, sub, fim, on, onClick })` | Linha clicável de lista: aparelho, coleção, lote, pasta. |
| `BotaoGrande({ icone, dica })` | A ação principal da tela (gradiente azul→violeta, 52 px). Uma por tela. |
| `Vazio({ icone, titulo, acoes })` | Estado vazio com o desenho que respira e as ações para sair dele. |
| `GraficoVelocidade({ pontos })` | Área + linha de ↓ (azul) e ↑ (violeta), do histórico de velocidade. |
| `.k-soltar` | Área de arrastar e soltar (tracejada, acende ao passar o arquivo). |

## Regras

- **Cabeçalho:** sempre `Pagina` (título + uma frase). Nada de título solto sem frase.
- **Conteúdo:** em `Passo`s. Fluxo com ordem (escolher → ajustar → fazer) = numerado; telas de consulta/ajustes =
  com ícone e cor (`cor`: `down`, `up`, `ok`, `warn`).
- **Ação principal:** `BotaoGrande` na coluna lateral (ou no fim do fluxo), com a `dica` dizendo o que falta ou o que vai
  acontecer. Ações secundárias continuam `Button` (pílula) do `common.js`.
- **Escolhas:** até ~4 opções que mudam o resultado = `Opcoes`; valores rápidos = `Pilulas`; liga/desliga = `Switch`
  numa `Linha`. Evite `<select>` quando couber em cartões.
- **Números:** o que importa vira `Destaque` ou `Stats`, não frase. Dado ao vivo (velocidade) vira gráfico.
- **Movimento:** blocos entram em cascata (`k-entra` com `--i`); barras correm; o `Destaque` brilha só quando algo anda.
  Tudo para com "reduzir movimento" (já tratado no kit). Nada pisca nem chama atenção sem motivo.
- **Texto:** português do dia a dia, curto, sem ponto de exclamação. Uma ideia por frase.
- **Cores:** só pelos tokens (`--down` azul = baixar/Drive, `--up` violeta = subir/enviar, `--ok`, `--warn`, `--err`).
  Funciona nos temas claro e escuro.
- **Tamanhos:** testar em 1440 px e 1000 px (janela mínima 980 px), claro e escuro.
