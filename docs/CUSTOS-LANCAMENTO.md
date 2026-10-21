# Custos para lançar o SOBEDESCE à venda

Lista do que vai custar **quando for vender**. Hoje nada disso é obrigatório: o app roda no plano grátis e a única consequência é o aviso do Mac/Windows na instalação.

> Valores aproximados (outubro/2026), de memória. **Conferir o preço atual no site de cada serviço antes de contratar.** Dólar em reais não está convertido de propósito.

## Resumo

| Prioridade | Item | Custo aproximado | Quando |
|---|---|---|---|
| 1 | Verificação do Google (escopo `drive`) | **US$ 540 a 4.500+ por ano** (avaliação CASA) | Antes de vender para público |
| 1 | Apple Developer Program | US$ 99 por ano | Antes de vender |
| 1 | Certificado de assinatura Windows | US$ 10/mês (Azure Trusted Signing) a US$ 200–400/ano | Antes de vender |
| 1 | Vercel Pro | US$ 20 por mês por usuário | Antes de vender (o plano grátis não permite uso comercial) |
| 1 | Cobrança (Stripe, Mercado Pago ou Asaas) | 1% a 4% por venda, sem mensalidade | Ao abrir a venda |
| 2 | Banco Neon (pago) | US$ 19 por mês (grátis até certo ponto) | Quando passar do limite grátis |
| 2 | Resend (e-mails) | Grátis até 3.000 e-mails/mês; depois US$ 20 por mês | Quando passar do limite grátis |
| 2 | Domínio sobedesce.com | cerca de US$ 12 a 15 por ano | Já existe; renovar |
| 3 | TURN (plano B da conexão Wi-Fi) | Cloudflare: grátis até 1 TB/mês, depois US$ 0,05 por GB | Se muita gente não conectar direto |
| 3 | Atualizações do app | Grátis (GitHub Releases) | Já está assim |
| 3 | GitHub Actions (builds Mac/Windows) | Grátis até um limite; minutos de Mac contam 10x | Se o repositório for privado e crescer |

## 1. Obrigatórios para vender

### Verificação do Google (o mais caro e o mais demorado)
- O app usa o escopo `https://www.googleapis.com/auth/drive` (ver `GOOGLE-NOTES.md`). O Google classifica como **escopo restrito**.
- Para ter mais de 100 usuários sem o aviso "app não verificado", precisa de:
  - verificação do app no Google Auth Platform;
  - **avaliação de segurança anual (CASA)** por um laboratório credenciado. É aqui que está o custo (da ordem de centenas a alguns milhares de dólares por ano, conforme o nível).
- Prazo: semanas. Começar **cedo**, antes da data de lançamento.
- Alternativa mais barata: usar o escopo `drive.file` (não exige CASA), mas ele **não permite** o comparador, que lista e lê qualquer arquivo. Decisão de produto a tomar.

### Apple Developer Program: US$ 99 por ano
- Assinatura + notarização do app no Mac.
- Resolve: o aviso "desenvolvedor não identificado" e, principalmente, o macOS **parar de pedir Rede Local e Firewall de novo a cada atualização** (hoje o app usa assinatura ad-hoc: `identity: "-"` e `notarize: false` em `electron-builder.yml`).

### Certificado de assinatura do Windows
- Sem ele, o SmartScreen mostra "O Windows protegeu o seu computador" na instalação.
- Opções:
  - **Azure Trusted Signing**: cerca de US$ 10 por mês (a mais simples; exige empresa com alguns anos de existência verificável, conferir elegibilidade).
  - Certificado OV de uma autoridade (Sectigo, DigiCert etc.): cerca de US$ 200 a 400 por ano.
  - Certificado EV: mais caro (US$ 300 a 600+ por ano), tira o aviso na hora.

### Vercel Pro: US$ 20 por mês por usuário
- O plano Hobby é só para uso pessoal e não comercial.

### Cobrança
- Stripe, Mercado Pago ou Asaas. Sem mensalidade; cobram por venda (cartão cerca de 3% a 4% + taxa fixa; Pix costuma ser bem menor, perto de 1%). Conferir as taxas de cada um.
- Falta construir no site: planos, checkout, cobrança recorrente, cancelamento e recibo.

## 2. Crescem com o número de usuários

- **Neon (banco):** o grátis tem limites de armazenamento e horas de uso. O pago começa em cerca de US$ 19 por mês.
- **Resend (e-mails):** grátis até 3.000 por mês (com limite diário). Depois cerca de US$ 20 por mês. Verificar também o domínio de envio.
- **Domínio:** renovação anual.

## 3. Só se precisar

- **TURN:** hoje a conexão celular ↔ computador usa só o STUN grátis da Cloudflare (`public/celular/p2p.js`). Redes que isolam os aparelhos (empresa, hotel) não conectam. Um servidor TURN faria o arquivo passar por fora dessas redes. O da Cloudflare é grátis até 1 TB por mês. **Cuidado:** o arquivo passaria pelo servidor, então muda o que a página de privacidade diz.
- **GitHub Actions:** os builds do Mac gastam bastante dos minutos grátis se o repositório for privado.
- **Monitoramento de erros (ex.: Sentry):** opcional; tem plano grátis.

## 4. Não é mensalidade, mas precisa ser feito

- **Empresa e nota fiscal:** definir se vende pela ZRO Produção Audiovisual LTDA ou por outro CNPJ, e se a atividade (CNAE) de software está coberta. Falar com o contador (Edu).
- **Termos de uso e privacidade:** revisão por advogado, com LGPD (a ZRO já tem adequação da LGPD pelo Sebrae/FUNCERN).
- **Registro da marca SOBEDESCE no INPI:** taxa do pedido na casa de algumas centenas de reais, mais honorários se usar um despachante. Conferir a tabela atual do INPI.
- **Suporte:** e-mail de atendimento e uma página de ajuda.

## Ordem sugerida
1. Decidir o escopo do Google (`drive` ou `drive.file`) e, se for `drive`, **abrir o processo de verificação já**.
2. Apple Developer (US$ 99) e assinatura do Windows.
3. Cobrança + Vercel Pro.
4. Neon e Resend pagos só quando os limites grátis apertarem.
