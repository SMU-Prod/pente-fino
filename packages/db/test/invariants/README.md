# Invariantes

As invioláveis da §3 do PRD, traduzidas em teste. Cada uma é bug de
severidade máxima, mesmo que o produto funcione.

| Inviolável | Suíte | Onde | Cobertura |
|---|---|---|---|
| INV-001 | `billing.spec.ts` | `packages/db` | Colunas SQL e campos de tipo em `@pentefino/core` (`RuleSpec`, `Playbook`, `ContestDocument`, `InvoiceCanonical`), vocabulário em português e inglês. Não cobre conteúdo arbitrário gravado em `jsonb` em tempo de execução — só a forma declarada nos tipos |
| INV-002 | `credentials.spec.ts` | `packages/db` | Automatizado só para `gov.br` em contexto de autenticação. Credencial de banco e de operadora ficam para revisão em PR, como a própria §3 do PRD prevê |
| INV-004 / INV-005 | `lint.spec.ts` | `packages/ai` | — |
| INV-006 | `sensitive.spec.ts` | `packages/db` | Vocabulário de saúde, religião, sindicato e política em português, sem acento, cobrindo termos reais de fatura/fatura de cartão (farmácia, dízimo, sindicato, eleitoral...). Toda regra, em **qualquer status** — draft/shadow/active/paused, não só active/shadow como a INV-010 — porque nada na redação da inviolável limita a checagem a regras em observação. Cobre `spec` (recursivamente, qualquer `kind`), `reason`, `slug` e `legalBasis`; não cobre `author` (nome de pessoa). Camada extra: nenhum arquivo-fonte de `packages/db/src/seeds` pode ter o vocabulário embutido, mesmo antes de virar seed. O motor (`runRules`) não produz achado nenhum para uma fatura fixture com itens de aparência sensível, dado o catálogo real de hoje (vazio — nenhum seed popula `rules` ainda) |
| INV-007 | `masking.spec.ts` | `packages/core` | — |
| INV-008 | `with-user.spec.ts` | `packages/db` | — |
| INV-010 | `suppressors.spec.ts` | `packages/db` | Regras `active` **e** `shadow` (RF-125/RF-126 — uma regra em `shadow` já grava achados reais e pode ser promovida sem revisão humana). Slug comparado de forma normalizada (separador e sufixo de versão ignorados), não por igualdade exata de string |

## Ainda sem teste, e por quê

| Inviolável | Depende de | Bloco |
|---|---|---|
| INV-003 (autoria do usuário) | gerador de contestação e templates | E4 |
| INV-009 (nada vendido à empresa) | revisão de arquitetura em PR, não teste automatizável | contínuo |

Nenhuma delas tem teste falso ocupando o lugar. Quando o bloco chegar, o
teste entra junto.
