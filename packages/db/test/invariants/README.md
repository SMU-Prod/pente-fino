# Invariantes

As invioláveis da §3 do PRD, traduzidas em teste. Cada uma é bug de
severidade máxima, mesmo que o produto funcione.

| Inviolável | Suíte | Onde |
|---|---|---|
| INV-001 | `billing.spec.ts` | `packages/db` |
| INV-002 | `credentials.spec.ts` | `packages/db` |
| INV-004 / INV-005 | `lint.spec.ts` | `packages/ai` |
| INV-007 | `masking.spec.ts` | `packages/core` |
| INV-008 | `with-user.spec.ts` | `packages/db` |
| INV-010 | `suppressors.spec.ts` | `packages/db` |

## Ainda sem teste, e por quê

| Inviolável | Depende de | Bloco |
|---|---|---|
| INV-003 (autoria do usuário) | gerador de contestação e templates | E4 |
| INV-006 (categoria sensível) | motor de regras com regras ativas | E2 |
| INV-009 (nada vendido à empresa) | revisão de arquitetura em PR, não teste automatizável | contínuo |

Nenhuma delas tem teste falso ocupando o lugar. Quando o bloco chegar, o
teste entra junto.
