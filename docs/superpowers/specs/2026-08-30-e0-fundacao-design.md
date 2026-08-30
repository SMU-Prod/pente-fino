# E0 · Fundação — desenho

**Data:** 30/08/2026 · **Escopo:** bloco E0 da §18 do `PRD.md`, na variante **sem credencial externa**.

---

## 1. Objetivo

Entregar a fundação do PENTE-FINO de forma que **todo o trabalho de domínio possa começar sem depender de nenhuma conta externa**, e que ligar as contas depois seja preencher `.env` — nunca reescrever código de domínio.

**Critério de pronto (§18, E0):** `pnpm test` verde e uma fatura de fixture percorre o pipeline vazio de ponta a ponta.

### O que "pipeline vazio" significa aqui

Uma fatura de fixture entra por `POST /api/uploads/sign`, é processada por `POST /api/invoices/:id/process`, passa por `classify → extract → validate → mask → rules` e termina em `status=analyzed` com **zero achados** — porque não existe nenhuma regra `active` no E0. O caminho está inteiro; o julgamento ainda não existe. Isso é intencional: o motor não finge julgar.

---

## 2. Fora de escopo

| Item | Motivo |
|---|---|
| `apps/mobile` | É E12. Pasta vazia só polui a árvore. |
| Golden set real (10 faturas × 3 operadoras) | Depende de faturas reais do Erick. O E0 entrega **formato, script de anonimização e runner**; a pasta nasce vazia. |
| Qualquer regra de detecção | É E2, e depende do léxico de `CLAUDE.md`, que ainda não existe. |
| Provisionamento de Neon, R2, Trigger.dev, Stripe, Resend, provedor de IA | Exige criação de conta e manuseio de credencial. |
| `packages/ui` com componentes | E0 entrega apenas os tokens da §13.1 e o preset do Tailwind. Componente sem tela é especulação. |

---

## 3. Estrutura

Exatamente a árvore da §5.3, menos `apps/mobile`:

```
pentefino/
├── PRD.md
├── CLAUDE.md                    (stub apontando para o PRD; o léxico vem depois)
├── package.json · pnpm-workspace.yaml · turbo.json
├── apps/
│   ├── web/                     Next.js 15 (App Router)
│   └── jobs/                    definições de task (executor local no E0)
├── packages/
│   ├── db/                      schema Drizzle, migrações, withUser, client
│   ├── core/                    domínio puro, sem I/O (inclui ports/ — só tipos)
│   ├── adapters/                implementações das ports: local no E0, real depois
│   ├── ai/                      lint de termos proibidos + prompts versionados
│   ├── ui/                      tokens + preset Tailwind
│   └── config/                  tsconfig, eslint (com a regra custom), tailwind
└── fixtures/
    └── golden/                  vazio, com README do formato
```

**Convenção de idioma (regra 7 do PRD):** conteúdo, interface e mensagens em pt-BR; código, identificadores, commits e comentários em inglês.

---

## 4. `packages/db`

### 4.1 Schema

As tabelas da §6.2 transcritas **como estão escritas**, sem invenção: `users`, `anonymous_sessions`, `issuers`, `invoices`, `invoice_items`, `rules`, `findings`, `cases`, `case_documents`, `case_protocols`, `events`, `ai_calls`, `prompts`, `reference_tariffs`, `reference_flags`, `aggregates`, `entitlements`, `seo_pages`, `rule_metrics`, `agent_proposals`.

Convenções da §6.1 valem para tudo: id `text` com prefixo semântico via `nanoid(21)`, dinheiro em centavos `integer`, `timestamptz`, enums como `text` com `CHECK`, `created_at`/`updated_at` em toda tabela.

Migração inicial inclui `CREATE EXTENSION IF NOT EXISTS pg_trgm` (§6.3).

### 4.2 `withUser` — o único caminho até dado de usuário

```ts
// packages/db/src/with-user.ts
export function withUser(session: Session): ScopedDb
```

`ScopedDb` expõe as consultas já filtradas por titularidade. **Nenhum módulo fora de `packages/db` importa o client cru.** Isso é `INV-008` e é imposto por lint, não por disciplina.

### 4.3 Regra ESLint custom

`packages/config/eslint/rules/require-with-user.ts` — reprova import do client do Drizzle fora de `packages/db`. Falha o CI.

### 4.4 Banco nos testes: PGlite

`@electric-sql/pglite` com o contrib de `pg_trgm`. Mesmo dialeto, mesmas migrações, sem daemon e sem conta. O Docker está instalado na máquina mas o daemon não sobe sozinho, e prender o CI a um daemon é fragilidade desnecessária.

Produção e dev com banco real continuam por `DATABASE_URL`. O client escolhe o driver pela presença da variável — não há branch de schema.

---

## 5. `packages/core` — domínio puro

Sem I/O (A2). Recebe JSON, devolve JSON.

### 5.1 Contratos (§7)

`InvoiceCanonical`, `RuleSpec`, `Finding`, `Playbook`, `ContestDocument` — em Zod, exatamente como no PRD, exportando tipo inferido.

### 5.2 Catálogo de eventos (§15.1)

`events.ts` com a lista `as const` e o tipo derivado. Nome de evento é contrato: adicionar é livre, renomear exige migração de dashboard.

### 5.3 Funções com assinatura fechada

| Função | E0 entrega |
|---|---|
| `normalize(desc)` | **completa** — caixa alta, remoção de acento, `Ç→C`, colapso de espaço, remoção de número variável (RF-122). É pura e testável hoje. |
| `validateInvoice(canonical)` | **completa** — as quatro validações determinísticas do RF-108. |
| `maskCanonical(canonical)` | **completa** — CPF, CNPJ do titular, endereço, código de barras, linha digitável (RF-109 / `INV-007`). |
| `runRules(input)` | assinatura fechada; com zero regras `active`, devolve `[]`. |
| `nextStage(current, playbook, event)` | assinatura fechada; tabela de decisão vazia, lança em combinação não mapeada. |
| `diffInvoices(a, b)` | assinatura fechada; devolve pareamento vazio. |

As três primeiras são reais no E0 porque são puras, autocontidas e sustentam invariantes. As três últimas são E2/E5/E6 — o E0 fixa a fronteira para que nada precise ser reescrito depois.

---

## 6. Adaptadores — o coração do "sem credencial"

Cada dependência externa entra por uma interface declarada em `packages/core/ports` — só o tipo, para o núcleo seguir puro (A2). As implementações moram fora do núcleo, em `packages/adapters`, e a escolha entre elas acontece na composição, por variável de ambiente, nunca dentro do domínio.

| Porta | Implementação E0 | Implementação real |
|---|---|---|
| `Storage` | disco local em `.data/blobs`, URL assinada por HMAC com expiração de 5 min | R2 |
| `TaskQueue` | executor em processo, mesma assinatura de task, idempotente por chave | Trigger.dev |
| `AiProvider` | devolve fixture, validada pelo mesmo Zod da real; grava em `ai_calls` com custo zero | AI SDK `generateObject` |
| `Mailer` | escreve em `.data/mail/*.eml` | Resend |
| `AuthProvider` | sessão anônima real (cookie assinado, ADR-07) + código por e-mail via `Mailer` falso | Better Auth |

**Regra:** a URL assinada do adaptador local expira de verdade e o teste verifica isso. Um fake que não respeita o contrato não testa nada.

> **Divergência registrada:** a §18 cita Better Auth no E0, mas não há ADR de autenticação na §5.4 e o RF-240 só descreve os fluxos (código por e-mail, Google, Apple). O E0 fixa a porta `AuthProvider`; a escolha da biblioteca fica para o E8, quando os três fluxos forem implementados de verdade.

---

## 7. `packages/ai` no E0

Só duas coisas, ambas determinísticas:

**`lint.ts`** — o lint de termos proibidos da §14.3, rodando antes de qualquer exibição. Rejeita e sinaliza para regeneração. Aceita "indevido" e "ilegal" apenas em citação de norma ou em texto de terceiro; fora disso, reprova. É `INV-004` e `INV-005`, e é implementável inteiro hoje.

**`prompts/`** — o texto versionado, com a v1 do prompt de extração da §20.3, semeado na tabela `prompts` (A5).

A porta `AiProvider` vive em `packages/core/ports` e a implementação de fixture em `packages/adapters`, como todas as outras — `packages/ai` não hospeda implementação de porta.

---

## 8. Invariantes que ficam verdes no E0

Estas testam **ausência** e **funções puras** — não dependem de feature futura, e por isso são verdes de verdade, não placeholder.

| Suíte | Verifica | Como |
|---|---|---|
| `invariants/billing.spec.ts` | `INV-001` | varre o schema Drizzle; falha se existir coluna `commission*`, `success_fee*` ou `percent*` |
| `invariants/credentials.spec.ts` | `INV-002` | grep no repositório: `gov.br` em contexto de autenticação reprova |
| `invariants/lint.spec.ts` | `INV-004`, `INV-005` | a lista completa da §14.3, com caso positivo e negativo por termo |
| `invariants/masking.spec.ts` | `INV-007` | regex de CPF não encontra ocorrência em `canonical` mascarado |
| `invariants/with-user.spec.ts` | `INV-008` | a regra ESLint reprova query direta em fixture de código |
| `invariants/suppressors.spec.ts` | `INV-010` | nenhuma regra `active` bloqueada por `RN-090..092` (trivialmente verde com zero regras, e continua válido em E2) |

`INV-003`, `INV-006` e `INV-009` dependem de código que só existe em E2/E4 — ficam registradas como pendentes no README da suíte, sem teste falso.

---

## 9. O caminho vazio, ponta a ponta

Teste de integração contra PGlite, que é o critério de pronto do E0:

```
fixture (PDF de uma página, sintético)
  → POST /api/uploads/sign        cria invoice status=queued, devolve URL assinada
  → upload no Storage local
  → POST /api/invoices/:id/process
      → classify   (heurística de emissor, sem IA — RF-105)
      → extract    (AiProvider fake devolve InvoiceCanonical de fixture)
      → validate   (RF-108, real)
      → mask       (RF-109, real)
      → runRules   (zero regras → [])
  → GET /api/invoices/:id/report  → status=analyzed, findings=[], totals zerados
```

Cada transição grava em `events` (A3). O teste verifica a sequência de eventos, não só o estado final.

Reprocessar a mesma fatura não cria segunda linha nem segunda chamada de IA (A4 / RF-102).

---

## 10. CI

`lint → typecheck → unit → contrato → build`, mais `gitleaks` (RNF-12). Sem golden set ainda — o job existe e passa vazio, com contagem exibida, para que a ausência seja visível e não silenciosa.

---

## 11. Dependências para os blocos seguintes

Registradas aqui para não virarem surpresa:

1. **`CLAUDE.md` com o léxico completo** — o E2 não tem o que semear sem ele (§20.1). É trabalho de conteúdo, não de código.
2. **Faturas reais para o golden set** — o E1 não fecha o RNF-16 sem elas, e o CI trava merge por regressão nesse número.
3. **Contas externas** — necessárias a partir do momento em que se queira exercitar o caminho real; nenhuma delas bloqueia E0, E2 ou a maior parte do E1.
