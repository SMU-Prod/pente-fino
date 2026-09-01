# E2 · Motor de regras — desenho

**Data:** 31/08/2026 · **Escopo:** bloco E2 da §18 (RF-120 a RF-129, mais as regras da §12), na variante **sem o léxico de `CLAUDE.md`**.

---

## 1. O que este bloco é

É onde o produto passa a **julgar**. Até aqui ele lê uma fatura e não diz nada sobre ela. Depois deste bloco ele aponta linhas e soma valores — e é por isso que é o bloco mais perigoso do projeto: um falso positivo aqui não é um bug, é uma acusação errada feita em nome do usuário.

O guardrail da §1.4 é falso positivo por regra **abaixo de 15%**, e o marco da §18 antes de abrir ao público é falso positivo agregado **abaixo de 15% medido em 200 laudos reais, com leitura manual de cada descarte**. Nada neste bloco mede isso — só o uso real mede. O que este bloco entrega é a máquina que torna a medição possível e o freio que a usa: modo sombra, limiar de confiança, pausa automática.

## 2. O que já está pronto

| Peça | Onde |
|---|---|
| `runRules` com assinatura fechada, `ActiveRule` com `legalBasis` e `issuerId`, `references` na entrada | E0/E1 |
| `normalizeDescription` (RF-122) | E1 — inclusive o caso de aceite do RF-122 |
| `Finding`, `RuleSpec`, `LegalRef` (§7.2, §7.3) | E0 |
| Tabelas `rules`, `findings`, `rule_metrics`, `aggregates` com CHECK | E0 |
| Suíte `invariants/suppressors` cobrindo `active` **e** `shadow`, com slug normalizado | E0 |
| Seis emissores semeados com as seções da §20.1 na coluna `sections` | E1 |

O motor tem a fronteira certa e nenhum avaliador dentro.

## 3. O que trava no léxico, e o que não trava

A §20.1 diz que o léxico completo de itens, agregadoras e prefixos de processador está em `CLAUDE.md` §7, que não existe. Isso **não** trava o bloco — trava três regras.

| Regra da §12 | Precisa do léxico? |
|---|---|
| RN-001 a RN-011 (determinísticas) | **não** — a §12.1 dá cada fórmula e cada base legal |
| RN-022 cluster · RN-024 cobrança após cancelamento · RN-025 multa e juros · RN-026 item duplicado | **não** |
| RN-040 a RN-042 (referência: tarifa, bandeira, tarifa social) | não do léxico — precisa dos dados da ANEEL |
| RN-090 a RN-092 (supressores) | **não** — a §12.4 dá as três teses mortas |
| RN-020 SVA em telecom | **metade** — a âncora de seção está semeada; o casamento por léxico não |
| RN-021 seguro embutido em cartão | sim |
| RN-023 assinatura recorrente por processador | sim — depende dos prefixos de processador |

Ou seja: **o motor inteiro, os sete avaliadores, os supressores, o modo sombra, as métricas e a maioria das regras se constroem agora.** Ficam de fora três regras de padrão e os dados tarifários.

## 4. Decisões

**O motor continua puro.** RF-120 exige `sem I/O` e mesma entrada produzindo mesma saída. Regras, referências e respostas do usuário entram como argumento; nada dentro de `packages/core` lê banco.

**Uma regra nova nunca nasce visível.** RF-125: `draft` → `shadow` por 7 dias → `active`. O achado em sombra é gravado com `shadow=true` e não aparece no laudo. Isso é o que permite ligar uma regra em produção e medir o falso positivo dela **antes** de mostrar a alguém.

**Confiança baixa vira pergunta, não acusação.** RF-124: abaixo de 0,55 o motor não cria achado visível — cria uma pergunta ao usuário. Entre 0,55 e 0,8 o laudo diz "verificar". Acima de 0,8, "provável cobrança a contestar". A §14.2 proíbe afirmar que a cobrança é indevida, e o lint do `INV-004` já reprova o vocabulário; o limiar é a metade do mesmo cuidado que fica no motor.

**A base legal vem da regra, nunca do modelo.** RF-129 exige `evidence` e `legalBasis` não vazios em todo achado, e o motor rejeita quem não tiver. O RF-161 do E4 depende disso: a peça de contestação cita só o que os achados trouxeram.

**O supressor remove, não deixa de criar.** O `suppressor` do RF-121 é um avaliador que apaga achados já produzidos, para que a razão do apagamento fique registrada. Uma tese morta suprimida em silêncio é indistinguível de uma regra que nunca disparou.

**A pausa automática é do produto, não da operação.** RF-127 pausa uma regra `active` com mais de 15% de descarte em 50+ disparos, sem intervenção humana. É o freio que torna aceitável ligar regras cedo.

## 5. Fora do bloco, e por quê

| Item | Motivo |
|---|---|
| RN-021 (seguro em cartão) e RN-023 (assinatura por processador) | dependem do léxico de `CLAUDE.md` §7 |
| A metade por léxico da RN-020 | idem — a metade por seção entra |
| Os dados tarifários da ANEEL (RN-040, RN-041) | o avaliador `reference` e a forma da tabela entram; a importação dos dados é trabalho de dados, com as armadilhas da §12.3 (filtrar `DscBaseTarifa`, gross-up de tributos, join por CNPJ) |
| A medição de falso positivo em 200 laudos | só o uso real mede |

## 6. Critério de pronto

Da §18: **a suíte `invariants/suppressors` verde, e uma regra em sombra não aparece no laudo.** Mais, porque o bloco não vale sem isso:

- cada um dos sete avaliadores tem teste com caso positivo **e** negativo (RF-121)
- uma regra específica de emissor suprime a genérica de mesmo slug (RF-123)
- um achado de confiança 0,5 não aparece no laudo e aparece como pergunta (RF-124)
- cinco SVAs na mesma seção viram um achado agregado no topo (RF-128)
- um achado sem evidência ou sem base legal é rejeitado pelo motor (RF-129)
- o job diário promove uma regra em sombra que merece, e pausa uma regra ativa que passou do limite, com evento em cada caso (RF-126, RF-127)
- nenhuma das três teses mortas da §12.4 pode ser sinalizada, nem por regra `active` nem por regra `shadow`, nem sob slug renomeado

## 7. O que continua dependendo do Erick

1. **`CLAUDE.md` §7** — o léxico. Destrava três regras de padrão, e são justamente as de maior volume em telecom.
2. **As faturas do golden set** — o §16.2 pede casos **negativos**, faturas sem nenhum achado, porque sem elas não há como medir falso positivo, que é o guardrail deste bloco.
3. **Os dados da ANEEL** — para RN-040 e RN-041.
