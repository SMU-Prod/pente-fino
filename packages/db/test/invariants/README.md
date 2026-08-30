# Invariantes

As invioláveis da §3 do PRD, traduzidas em teste. Cada uma é bug de
severidade máxima, mesmo que o produto funcione.

| Inviolável | Suíte | Onde | Cobertura |
|---|---|---|---|
| INV-001 | `billing.spec.ts` | `packages/db` | Colunas SQL e campos de tipo em `@pentefino/core` (`RuleSpec`, `Playbook`, `ContestDocument`, `InvoiceCanonical`), vocabulário em português e inglês. Não cobre conteúdo arbitrário gravado em `jsonb` em tempo de execução — só a forma declarada nos tipos |
| INV-002 | `credentials.spec.ts` | `packages/db` | Automatizado só para `gov.br` em contexto de autenticação. Credencial de banco e de operadora ficam para revisão em PR, como a própria §3 do PRD prevê |
| INV-004 / INV-005 | `lint.spec.ts` | `packages/ai` | — |
| INV-007 | `masking.spec.ts` | `packages/core` | — |
| INV-008 | `with-user.spec.ts` | `packages/db` | — |
| INV-010 | `suppressors.spec.ts` | `packages/db` | Regras `active` **e** `shadow` (RF-125/RF-126 — uma regra em `shadow` já grava achados reais e pode ser promovida sem revisão humana). Slug comparado de forma normalizada (separador e sufixo de versão ignorados), não por igualdade exata de string |

## Ainda sem teste, e por quê

| Inviolável | Depende de | Bloco |
|---|---|---|
| INV-003 (autoria do usuário) | gerador de contestação e templates | E4 |
| INV-006 (categoria sensível) | motor de regras com regras ativas | E2 |
| INV-009 (nada vendido à empresa) | revisão de arquitetura em PR, não teste automatizável | contínuo |

Nenhuma delas tem teste falso ocupando o lugar. Quando o bloco chegar, o
teste entra junto.
