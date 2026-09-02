# Amostra de eval da contestação (§20.4)

Vazio de propósito. **20 casos por versão de prompt**, o tamanho de amostra
que a §20.4 pede para calcular a aprovação (>= 8/10). O harness (veja
abaixo) já existe — o que falta é a amostra em si, e ela só existe depois
que o gerador da Tarefa 2 (`packages/ai`, atrás de `AI_GATEWAY_API_KEY`)
produzir documentos de verdade. Até lá, `pnpm eval:contest` roda sobre zero
casos, passa e avisa alto que não está medindo nada — a mesma postura de
`pnpm golden:run` sobre `fixtures/golden` enquanto não há fatura real.

## Formato

Cada caso é uma pasta:

```
fixtures/eval/contest/caso-001/
├── document.json     o ContestDocument (§7.5) gerado
└── assembled.json    o AssembledContest (packages/core, assemble.ts) usado para gerá-lo
```

`assembled.json` tem a forma que `assembleContest` retorna: pelo menos
`asks` (os pedidos do playbook para a etapa) e `legalRefs` (as bases legais
vindas dos achados, nunca do playbook em si) são obrigatórios — são a
referência contra a qual o harness mede dois dos três critérios
determinísticos. `protocols`, `attachmentsChecklist` e
`mandatoryScriptItems`, se presentes, não são usados por este harness hoje.

## O que `scripts/eval-contest.mjs` mede

Da rubrica da §20.4, três dos cinco critérios são determinísticos — pedidos
do playbook (peso 3), bases legais (peso 3), termos proibidos (peso 2), 8
dos 10 pontos — e é exatamente isso que o harness roda, contra o
`assembleContest` e o `lintUserFacingText` reais, sem chamar modelo nenhum.
Os outros dois (protocolos/prazos vencidos; tamanho e tom neutro) exigem
julgamento — de data (que `AssembledContest.protocols` ainda não carrega) ou
de um modelo — e voltam no relatório marcados como não medidos, nunca como
aprovados por omissão.

A aprovação do bloco (>= 8/10 da rubrica inteira) não pode ser certificada
só por este harness: ele mede 8 dos 10 pontos. Ver
`docs/superpowers/specs/2026-08-31-e4-contestacao-design.md` §6 para o
critério de pronto completo do bloco.
