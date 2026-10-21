# Planos, preços e roadmap do SOBEDESCE

Decisões do Victor (outubro/2026). Preços são **hipóteses para testar**, não números de mercado conferidos. Custos em `CUSTOS-LANCAMENTO.md`.

## Planos

| | Grátis | Pro | Produtora |
|---|---|---|---|
| Preço | R$ 0 | R$ 39/mês ou R$ 390/ano | R$ 129/mês ou R$ 1.290/ano |
| Aparelhos por conta do Drive | 2 | **3** | 5 |
| Aparelho extra | não | não | **R$ 25/mês (R$ 250/ano) cada** |
| Calculadora de mídia, Wi-Fi entre aparelhos | ✔ | ✔ | ✔ |
| Comparador, Entre discos, Frames, busca por cena | limitados | ✔ | ✔ |
| **Backup Automático** | ✘ | ✘ | **✔** |

Decisões:
- O limite conta **aparelhos por conta do Drive** (grátis 2, Pro 3, Produtora 5).
- **Backup Automático é exclusivo da Produtora**: é a função que leva a pessoa a assinar o plano de R$ 129. Quem assina também ganha 2 computadores a mais.
- **Sem passe avulso por evento**: o valor fica em R$ 129 por mês.
- Aparelho extra a R$ 25 = mesmo preço por aparelho da Produtora (R$ 129 / 5 ≈ R$ 26). Faixa de teste: R$ 19 a R$ 29. Acima de ~10 aparelhos, preço combinado.

## Conta rápida (hipótese)
- Infraestrutura: ~R$ 1.700/mês (ver custos).
- De cada assinatura sobram ~90% (taxa de cobrança ~4% + imposto ~6%, confirmar com o Edu).
- Só a infraestrutura: ~50 assinantes Pro, ou ~15 Produtora.
- Reservar 15% a 25% da receita para marketing.

## Roadmap em fases
Cada fase só gasta dinheiro depois que a anterior mostrou resultado.

**Fase 0 · feito:** app Mac/Windows, celular, Wi-Fi direto, Drive, comparador, Entre discos, Backup Automático, Frames, Cartões, Entre computadores.

**Fase 1 · beta fechado (sem cobrar):**
- Testar Windows, Android e iPhone ↔ Windows.
- Decidir o escopo do Google (`drive` ou `drive.file`) e abrir a verificação.
- Lista de espera e 10 a 20 convidados (começar pelo Carro do Freela).

**Fase 2 · lançamento pago (começam os gastos):**
- Planos, teste grátis de 14 dias, checkout e cobrança.
- Limite de aparelhos por conta do Drive e Backup Automático travado na Produtora.
- Assinatura do app no Mac e no Windows.
- Vercel Pro, termos e privacidade revisados, e-mail de suporte.

**Fase 3 · crescimento:** plano anual, aparelho extra, indicação (1 mês grátis), página de preços, vídeos, aviso do Firewall no Windows.

**Fase 4 · depois de ter assinantes:** Máxima segurança no Entre discos, relatório de backup em PDF, plano para equipes maiores.

**Fase avançada · "Enviar de qualquer lugar" (TURN):**
- Hoje o Wi-Fi direto só funciona na mesma rede (sem TURN). De um 5G para outro 5G não conecta; o caminho é o Drive.
- Ligar um servidor TURN (Cloudflare: grátis até 1 TB/mês, depois US$ 0,05 por GB).
- Só no Pro e na Produtora, para o plano cobrir o custo por GB.
- Atualizar a página de privacidade (o arquivo pode passar por um servidor, criptografado).

## Funções guardadas: lançar uma por mês
Ideia do Victor: não lançar tudo de uma vez; novidade mensal mantém a assinatura.

- **No lançamento:** Wi-Fi entre celular e computador, Drive, comparador e Entre discos, calculadora de mídia, Backup Automático (Produtora).
- **Mês 1:** Entre computadores · **Mês 2:** Frames · **Mês 3:** Resgate de vídeo · **Mês 4:** Busca por cena · **Mês 5:** LOG → Rec.709 · **Mês 6:** relatório de backup em PDF + Máxima segurança.
- Ritmo: 1 novidade por mês, no mesmo dia, junto com uma melhoria de velocidade ou estabilidade. Cada lançamento: aviso no app, e-mail e post no Instagram.
- Cada função guardada passa 1 mês em beta antes de sair. A conferir no código: se cada função já fica atrás de um interruptor no servidor.
- Página pública "o que vem aí" para quem assina o plano anual.

