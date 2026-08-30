# Golden set

Vazio de propósito. **10 faturas reais anonimizadas por emissor**, meta de 50
(PRD §16.2). Quando este conjunto e o workflow de CI existirem, o CI vai
travar merge se o acerto de extração cair (RNF-16) — hoje nenhum dos dois
existe neste repositório, então essa trava ainda não existe.

## O que é preciso

Faturas reais de pelo menos 3 operadoras. Sintetizar não serve: o golden set
mede acerto de extração sobre o layout de verdade, e um layout inventado
mediria a própria invenção.

## Formato

Cada caso é uma pasta:

```
fixtures/golden/claro-movel/2026-07/
├── source.pdf          fatura anonimizada, layout preservado
├── expected.json       InvoiceCanonical esperado
└── findings.json       lista de achados esperados (vazia até o E2)
```

## Anonimização

Um script `pnpm golden:anonymize <arquivo>` vai trocar CPF, nome, endereço e
número de linha preservando o layout — o layout é justamente o que está sob
teste. Esse script ainda não existe.

## Casos negativos

O conjunto precisa conter faturas **sem nenhum achado**. Sem elas não há como
medir falso positivo, que é o guardrail de §1.4.
