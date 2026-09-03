# Fixtures de par de faturas (RF-201, E6 Task 2)

**Sintéticas, escritas à mão para exercitar `classifyContestedItems`
(`packages/core/src/diff/outcome.ts`) e a função de pareamento
`pairInvoiceItems` que ela usa.** Não são golden set: não vieram de fatura
real e não medem acerto de extração. `fixtures/golden/` continua vazio de
propósito (ver `fixtures/golden/README.md`) — golden set e estes pares
respondem a perguntas diferentes: extração de layout real vs. lógica de
diff/desfecho sobre um `InvoiceCanonical` já extraído.

Cada linha usa o léxico de SVA de telecom confirmado em `CLAUDE.md` §7.1.2
(Skeelo, GoRead, Hube Jornais, NBA Básico) para que as descrições pareçam
reais, mesmo que a fatura em si seja inventada.

## Os pares

Cada par é a fatura N e a fatura N+1 da mesma linha contestada, dois
arquivos (`<caso>-n.json`, `<caso>-n1.json`), ambos um `InvoiceCanonical`
completo.

| Par | Prova |
|---|---|
| `disappeared` | O SVA contestado ("Skeelo Premium") some de N para N+1, sem crédito nenhum → verdict `disappeared`. |
| `reversal-equal` | O SVA contestado ("GoRead") continua cobrado em N+1 **e** um crédito de valor exatamente igual ao contestado aparece na mesma fatura → verdict `reversed` (correspondência exata). |
| `reversal-double` | O SVA contestado ("Hube Jornais") some de N para N+1 **e** um crédito do **dobro** do valor contestado aparece — prova ao mesmo tempo a aritmética do dobro e que reversão vence desaparecimento (RF-201: reversão é avaliada primeiro). |
| `still-charged` | O SVA contestado ("NBA Básico") continua cobrado em N+1, com valor reduzido e sem nenhum crédito → verdict `still_charged`. O valor reduzido (não igual ao original) prova que uma cobrança apenas menor continua sendo "ainda cobrado", não um quarto veredito. |
| `recurring-credit` | O SVA contestado ("Skeelo Premium") continua cobrado em N+1 **e** um crédito recorrente ("Desconto Fidelidade", -1990) aparece — mas o mesmo crédito, com a mesma descrição e o mesmo valor, já existia em N → verdict `still_charged`, não `reversed`. Prova que um crédito pareado entre N e N+1 (a mesma linha recorrente, não dinheiro que voltou) nunca conta como estorno, mesmo batendo exatamente no valor contestado. |

## O arquivo extra: `reappeared-n2.json`

A fatura N+2 do par `disappeared` (`disappeared-n.json` → `disappeared-n1.json`
→ `reappeared-n2.json`), com o SVA de volta. Não é usada pelo teste desta
task — é o fixture que a Task 4 (RF-203, reaparecimento) vai consumir,
diffando `disappeared-n1.json` (N+1, sem o item) contra `reappeared-n2.json`
(N+2, com o item de volta). Está aqui porque pertence à mesma história e
porque `packages/core/src/diff/fixtures.test.ts` já garante que ela também
faz `InvoiceCanonical.parse(...)` sem erro — uma fatura malformada falha
aqui, não três camadas acima, na Task 4.
