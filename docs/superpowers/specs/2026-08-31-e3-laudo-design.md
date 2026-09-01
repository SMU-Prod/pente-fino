# E3 · Laudo e card — desenho

**Data:** 31/08/2026 · **Escopo:** bloco E3 da §18 (RF-140 a RF-147), mais os requisitos não funcionais que o §18 nomeia como critério de pronto: RNF-01 e RNF-03.

---

## 1. O que muda neste bloco

Os três blocos anteriores construíram um produto que ninguém consegue usar. Existe pipeline, existe motor de regras, existe API — e uma única página que diz "Pente-fino" e mais nada. Este é o bloco em que o produto ganha rosto.

Isso muda a natureza do risco. Até aqui um defeito era um número errado num banco. Aqui um defeito é uma frase errada na frente de uma pessoa que está decidindo se contesta a conta dela.

## 2. O que já existe

| Peça | Onde |
|---|---|
| Sessão anônima assinada, 30 dias (RF-140) | E0 — cookie httpOnly, rejeita adulteração, produção sem segredo derruba o boot |
| `GET /api/invoices/:id/report` com achados, totais, emissor, faixa do RF-124 e `askUser` | E2 |
| `POST /api/findings/:id/feedback` — o "isso eu contratei" do RF-143 | E2 |
| Achado em sombra invisível ao laudo e fora do total | E2 |
| Tokens da §13.1 e preset do Tailwind | E0 |
| Mailer local, atrás da porta, escrevendo em disco | E0 |
| Mascaramento com dígito verificador (`INV-007`) | E0/E1 |

O laudo tem tudo por trás e nenhuma tela.

## 3. O que falta, e o que é difícil em cada coisa

**RF-141, o SSE.** A §8.2 especifica `GET /api/invoices/:id/status` como stream, com passos nomeados e porcentagem, e o aceite pede ao menos quatro eventos distintos entre `queued` e `analyzed`. A fila hoje roda **inline**: `POST /process` só responde depois que a ingestão termina. Um stream de progresso sobre um processo síncrono não tem o que transmitir. Esse é o problema de desenho do bloco, não a tela.

**RF-143, o laudo.** A §13.3 manda: nunca spinner mudo, confiança sempre visível junto ao achado **em linguagem simples e não em número cru**, valor em dobro ao lado do cobrado quando a base legal permitir, e todo estado vazio escrito. A §14.2 manda o texto exato. O lint do `INV-004` já reprova o vocabulário proibido — e agora ele tem onde ser aplicado de verdade.

**RF-144, o `needs_review`.** Tela própria, mensagem honesta, opção de reenviar. O A8 em forma de interface: quando não deu pra ler, dizer que não deu pra ler.

**RF-145, o card.** `ImageResponse` 1200×630 sem nome, CPF, número de linha ou endereço — e o aceite pede um teste que verifique ausência de PII **no payload**, não só na imagem.

**RF-146, a página pública `/l/[token]`.** Dados anonimizados, token aleatório e revogável. É a primeira superfície do produto acessível sem sessão nenhuma, e portanto a primeira onde um vazamento é público.

**RF-147, a reivindicação por e-mail.** `POST /api/sessions/claim` da §8.2: manda código, confirma, migra `invoices.sessionId` para `userId` sem perder achado.

## 4. Decisões

**A fila precisa parar de rodar inline.** Sem isso o RF-141 não existe e o RNF-01 (p50 ≤ 8s) não é medível, porque o tempo até o laudo é o tempo da requisição inteira. O adaptador local passa a executar fora do ciclo da resposta, mantendo a mesma porta — a implementação real do Trigger.dev entra no E5 sem mudar forma.

**A confiança aparece em palavra, não em número.** A §13.3 é explícita. As faixas do RF-124 já vêm da API; a tela escolhe a palavra. "Para você verificar" e "provável cobrança a contestar" são o texto da §14.2, e nada além disso.

**A página pública nasce anonimizada, não anonimizada depois.** O que `/l/[token]` serve é montado a partir do que já está mascarado no banco, mais uma segunda checagem antes de responder. Duas travas porque é a única superfície sem sessão.

**Nenhuma tela usa o visual padrão do shadcn.** A §13.1 diz o porquê: já é reconhecível como app de IA genérico. Os tokens existem desde o E0 e são a base.

## 5. Fora do bloco

| Item | Motivo |
|---|---|
| O painel de latência do RF-142 | A medida existe em `ai_calls`; a tela de série temporal é do admin, E11 |
| Autenticação de verdade (Google, Apple) | RF-240, bloco E8 |
| Envio real de e-mail | Precisa do Resend; o mailer local escreve em disco e exercita o caminho |

## 6. Critério de pronto

Da §18: **RNF-01 e RNF-03 atingidos.** Mais os aceites de cada RF:

- um navegador sem conta vê o laudo completo (RF-140)
- o cliente recebe ao menos quatro eventos distintos entre `queued` e `analyzed` (RF-141)
- o laudo mostra total a verificar, total em dobro quando cabe, confiança em palavra, evidência em uma frase e o botão "isso eu contratei", e o feedback grava evento e tira o item da vista (RF-143)
- uma fatura em `needs_review` mostra tela própria, sem laudo parcial inventado (RF-144)
- o card não carrega PII no payload (RF-145)
- `/l/[token]` funciona sem sessão e devolve 404 depois de revogado (RF-146)
- confirmar o código migra faturas e achados da sessão para o usuário (RF-147)
- LCP ≤ 2,0s e bundle inicial ≤ 120 kB gzip, verificados no CI e não no olho (RNF-03, RNF-05)
- axe sem violação crítica nas telas (RNF-09), e o teste visual nos dois temas (RNF-10)

## 7. O que continua dependendo do Erick

As faturas do golden set e a chave do modelo seguem sendo o que separa este produto de uma demonstração: sem elas o laudo tem tela, tem texto e não tem achado nenhum pra mostrar.
