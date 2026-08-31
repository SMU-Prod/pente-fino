# Golden set

Vazio de propósito. **10 faturas reais anonimizadas por emissor**, meta de 50
(PRD §16.2). Quando este conjunto e o workflow de CI existirem, o CI vai
travar merge se o acerto de extração cair (RNF-16) — hoje o script de
anonimização já existe (veja abaixo), mas o conjunto e o runner de CI ainda
não, então essa trava ainda não existe.

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

```
pnpm golden:anonymize <fatura.pdf> <pasta-do-caso>
```

troca CPF, nome, endereço e número de linha preservando o layout — o layout é
justamente o que está sob teste — e escreve `<pasta-do-caso>/source.pdf`.
`expected.json` e `findings.json` são escritos à mão depois, olhando para o
PDF anonimizado que o script produziu.

**O que o script cobre de verdade** (implementado em
`scripts/golden-anonymize.mjs`, com a lista completa de limitações no
cabeçalho do arquivo):

- entende exatamente a forma de PDF que
  `fixtures/synthetic/pdfs/make-fixtures.mjs` produz — tabela de
  cross-reference clássica, texto mostrado com o operador `Tj` de string
  literal, filtro de stream `FlateDecode` ou nenhum, fonte simples (não
  `Type0`/CID). Fora dessa forma, o script recusa o arquivo inteiro em vez
  de mascarar só o que entende e devolver algo parcialmente anonimizado —
  isso inclui o caso comum de um PDF real que mostra texto com arrays `TJ`
  (o normal quando o gerador aplica kerning) ou com string em hexadecimal.
- CPF, endereço e CEP são detectados reaproveitando `maskText`/`containsPii`
  de `@pentefino/core` (o mesmo detector, com dígito verificador, que o
  pipeline de produção usa) — nunca um segundo detector.
- **CNPJ nunca é mascarado**, de propósito: é o CNPJ do emissor, não da
  pessoa, e `detectIssuer` resolve o emissor a partir dele (RF-105). Mascarar
  o CNPJ deixaria todo caso do golden set permanentemente incapaz de testar
  RF-105.
- **nome e número de linha não têm detector nenhum em `packages/core`**
  (limitação de propósito do E0), então o script usa heurísticas próprias,
  sem dígito verificador: nome só é reconhecido quando segue um rótulo
  ("Nome:", "Cliente:", "Titular:", "Razão Social:") na mesma linha; número
  de linha só quando tem a forma de telefone brasileiro. **Quem trouxer a
  primeira fatura real precisa revisar `source.pdf` à mão antes de confiar
  nele** — o script imprime um aviso a cada execução, mas só consegue
  verificar sozinho a remoção de CPF/endereço (reler o próprio resultado com
  o leitor real de `@pentefino/adapters` e recusar escrever o arquivo se
  sobrar algo).

## Casos negativos

O conjunto precisa conter faturas **sem nenhum achado**. Sem elas não há como
medir falso positivo, que é o guardrail de §1.4.
