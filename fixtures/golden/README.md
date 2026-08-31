# Golden set

Vazio de propósito. **10 faturas reais anonimizadas por emissor**, meta de 50
(PRD §16.2). O script de anonimização (veja abaixo) e o runner + gate de CI
(RNF-16) já existem — o que falta agora é só o conjunto em si: faturas reais.
Até a primeira chegar, `pnpm golden:run` roda sobre zero casos, passa e avisa
alto que não está medindo nada (veja "Runner e o gate do RNF-16" abaixo).

## O que é preciso

Faturas reais de pelo menos 3 operadoras. Sintetizar não serve: o golden set
mede acerto de extração sobre o layout de verdade, e um layout inventado
mediria a própria invenção.

## Formato

Cada caso é uma pasta:

```
fixtures/golden/claro-movel/2026-07/
├── source.pdf      fatura anonimizada, layout preservado
├── expected.json   ver "expected.json" abaixo
└── findings.json   lista de achados esperados (vazia até o E2)
```

### `expected.json`

O objetivo final (PRD §16.2) é comparar contra um `InvoiceCanonical`
completo, mas isso depende da extração por IA — que faz uma chamada real de
modelo e ainda não foi ligada ao runner. O que já é real, sem nenhuma conta
externa, é o leitor de PDF, o score de qualidade/rota (RF-107) e o detector
de emissor por CNPJ/alias (RF-105) — então é exatamente isso que
`scripts/golden-run.mjs` roda e mede hoje. `expected.json` tem por enquanto
esta forma:

```json
{
  "reader": { "pageCount": 2, "hasTextLayer": true },
  "quality": { "route": "text" },
  "issuer": {
    "candidates": [
      { "id": "iss_claro_movel", "slug": "claro-movel", "displayName": "Claro Móvel",
        "cnpj": "40432544000147", "aliases": ["Claro", "Claro S.A."] }
    ],
    "issuerId": "iss_claro_movel",
    "matchedOn": "cnpj"
  }
}
```

`issuer.candidates` é a lista de emissores candidatos passada para
`detectIssuer` — cada caso carrega a sua própria (em vez do runner importar
`@pentefino/db`, que não é dependência deste script), então um caso pode
incluir concorrentes de propósito para testar desambiguação, além do emissor
correto. Um caso **negativo** de emissor usa `"issuerId": null,
"matchedOn": "none"`.

Quando a extração por IA for ligada ao runner, `expected.json` ganha uma
seção `canonical` com o `InvoiceCanonical` completo — isso é trabalho de uma
tarefa futura, não desta.

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

## Runner e o gate do RNF-16

```
pnpm golden:run
```

Para cada pasta de caso em `fixtures/golden/`, lê `source.pdf` com o leitor
real (`createUnpdfReader`), roda o score de qualidade real
(`extractionQuality`) e o detector de emissor real (`detectIssuer`), compara
cada saída contra `expected.json` e reporta o **acerto por campo-chave**:
`reader.pageCount`, `reader.hasTextLayer`, `quality.route`, `issuer.issuerId`
e `issuer.matchedOn`. RNF-16 exige ≥ 95% de acerto em cada um; qualquer campo
abaixo disso faz o comando sair com código de erro, apontando exatamente qual
caso e qual campo regrediu.

**Com o conjunto vazio (o estado de hoje) o comando passa** — reporta zero
casos e avisa alto que não está medindo nada, do mesmo jeito que
`pnpm golden:count` já faz. Um gate que "passa" silenciosamente sobre zero
casos leria como "extração está verificada" quando não está nada verificado;
por isso o aviso é alto e não silencioso.

**Onde o gate roda — decisão registrada aqui:** `pnpm golden:run` é um step
de CI **separado** (`.github/workflows/ci.yml`, depois de `golden:count`),
não faz parte de `pnpm test`. O runner em si (`scripts/golden-run.mjs`) tem
sua própria suíte (`scripts/golden-run.test.mjs`), essa sim ligada a
`pnpm test`, então todo `pnpm test` local continua provando que o mecanismo
funciona. Mas a *medição* de RNF-16 depende do conjunto de fixtures
commitado, que só existe em CI/PR de verdade quando alguém adiciona um caso
— colocar isso dentro de `pnpm test` bloquearia a máquina de todo
desenvolvedor por uma medição que, na prática, muda só quando o conjunto ou
o pipeline de extração mudam, não a cada `git commit`. PRD §16.2 diz "Roda em
CI. Qualquer queda de acerto bloqueia o merge" — um step obrigatório e
separado no workflow de CI cumpre exatamente isso, no mesmo lugar onde
`golden:count` já vive.

**Prova de que o gate pega regressão:** `scripts/golden-run.test.mjs` monta,
em um diretório temporário, um caso a partir do fixture sintético já
existente `fixtures/synthetic/pdfs/text-2page.pdf` (o mesmo que
`packages/core/src/invoice/detect-issuer.test.ts` já usa para "Claro
Móvel"), roda o gate com um `expected.json` correto (passa, 100% em todo
campo) e depois com um `expected.json` corrupto (falha, citando o caso e o
campo exato que regrediu). Esse caso sintético **não** vive em
`fixtures/golden/` — só em um diretório temporário criado e apagado pelo
próprio teste — porque qualquer pasta ali, mesmo rotulada como sintética,
faria `pnpm golden:count` contar "1" e o próprio `golden:run` reportar "1
caso", o que é exatamente a confusão entre medição real e dado inventado que
este conjunto existe para evitar.

## Casos negativos

O conjunto precisa conter faturas **sem nenhum achado**. Sem elas não há como
medir falso positivo, que é o guardrail de §1.4.
