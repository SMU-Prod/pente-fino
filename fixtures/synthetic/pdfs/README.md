# PDFs sintéticos

PDFs construídos à mão (ver `make-fixtures.mjs`) para testar o adapter unpdf
(`packages/adapters/src/reader/unpdf.ts`) e, mais adiante, o gate de arquivo.
**Não são golden set**: não vieram de fatura real, não têm layout de operadora
nenhuma e não medem acerto de extração — medem se o parser (unpdf/pdf.js)
consegue ler a estrutura de um PDF, nada além disso.

## Arquivos

- `text-2page.pdf` — duas páginas com camada de texto real, contendo
  `Claro Móvel`, `CNPJ 40.432.544/0001-47`, `Total a pagar R$ 129,90` e
  `Vencimento 10/08/2026`.
- `scan-1page.pdf` — uma página com um retângulo desenhado e nenhum operador
  de texto, simulando uma página de scan sem camada de texto.
- `text-13page.pdf` — treze páginas de texto, para exercitar o limite de
  páginas do RF-104.

## Regenerar

```
node fixtures/synthetic/pdfs/make-fixtures.mjs
```

O script recalcula os offsets do xref a partir dos bytes que ele mesmo
escreve — nunca de um número fixo — então adicionar uma quarta fixture ou
mudar o conteúdo de uma página não deixa um offset desatualizado para trás.
