# E2 · Motor de regras — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the product judgement — seven evaluators, the rules PRD §12 fully specifies, suppressors, shadow mode, confidence thresholds, clustering, and the automatic brake that pauses a rule producing false positives.

**Architecture:** `runRules` in `packages/core` stays pure: rules, references and the user's prior answers arrive as arguments and it returns findings. Each evaluator is its own module with one job. Everything that reads or writes the database — loading active rules, recording findings, materialising metrics, promoting and pausing — lives in `apps/jobs` and `packages/db`.

**Tech Stack:** the E0/E1 stack. No new runtime dependency is expected; if a task believes it needs one, it must justify it in its report.

## Global Constraints

- **Language:** content, UI and user-facing messages in pt-BR; code, identifiers, commits and comments in English.
- **`packages/core` does no I/O** (A2, RF-120). Same input, same output, always.
- **Money:** `integer` in cents, never float. Percentages and tolerances are explicit, never implied by a float comparison.
- **`INV-006`:** no rule may key on a sensitive category — health, religion, union membership, politics. The engine must not make that inferable either.
- **`INV-010`:** the three dead theses of RN-090 to RN-092 can never be signalled, by an `active` rule or a `shadow` one, under any slug.
- **`INV-004` / `INV-005`:** every string a finding can put in front of a user passes the forbidden-term lint. A finding says "a verificar" or "provável cobrança a contestar", never that a charge is illegal.
- **RF-129:** every finding carries at least one evidence sentence and at least one legal reference, and the engine rejects one that does not.
- **`packages/core` coverage floor:** 90% on lines, functions, branches and statements, test files excluded.
- ESM with `verbatimModuleSyntax`: `.js` extensions on relative imports, `import type` for type-only imports.
- Windows locally, Linux in CI.

**What already exists — read before building on it:** `runRules`'s closed signature and `ActiveRule` (with `legalBasis`, `issuerId`, `spec`, `confidenceBase`, `shadow`); `RuleSpec`'s seven kinds; `Finding`; `normalizeDescription`, which already satisfies RF-122 including its stated acceptance case; the `rules`, `findings`, `rule_metrics` and `aggregates` tables; `createTestDb` seeding six issuers with their §20.1 section names; and the `invariants/suppressors` suite, which already covers `active` and `shadow` and normalised slugs.

**Out of scope, by decision recorded in the design spec:** RN-021, RN-023 and the lexicon half of RN-020, all blocked on `CLAUDE.md` §7; and the ANEEL tariff data import for RN-040/RN-041, which is data work with its own traps.

---

### Task 1: The four self-contained evaluators — `pattern`, `threshold`, `arithmetic`, `duplicate`

**Files:** `packages/core/src/rules/evaluators/{pattern,threshold,arithmetic}.ts` and their tests; `packages/core/src/rules/evaluators/index.ts`.

**Produces:** `type Evaluator = (rule: ActiveRule, ctx: EvaluationContext) => Finding[]`; `type EvaluationContext = { invoice: InvoiceCanonical; previous: InvoiceCanonical | null; references: References; answers: Record<string, string> }`; one exported evaluator per kind.

Each evaluator takes a rule and the context and returns findings. None of them reads anything outside the context.

- `pattern` — matches `spec.match` against normalised item descriptions, optionally restricted to `spec.sections`, excluding `spec.notMatch`, honouring `spec.valueRange` and `spec.requireRecurrence`. Recurrence needs the previous invoice; with none, a rule requiring recurrence produces nothing rather than assuming.
- `threshold` — evaluates `spec.expr` against `spec.operator` and `spec.value`. Decide deliberately what expression language `expr` is: a tiny named-field lookup is enough for §12's rules and cannot execute arbitrary code. **Do not use `eval` or `new Function`** — a rule row is configuration edited through an admin panel, so an expression that can execute is a remote code execution path. Say what you chose.
- `arithmetic` — evaluates `spec.formula` against `spec.expect` within `spec.tolerancePct`. Same constraint on the expression language, same reasoning.

**RF-121 requires a positive and a negative test for each.** Beyond that, test what breaks these in practice: a pattern that matches nothing; a value range whose bounds are inclusive or exclusive (decide and document which); a threshold on a field the invoice does not have; an arithmetic formula whose operands are missing; and a tolerance of exactly the boundary.

Every finding these produce must carry `evidence` and `legalBasis` from the rule, per RF-129.

---

### Task 2: The three contextual evaluators — `delta`, `reference`, `confirm`

**Files:** `packages/core/src/rules/evaluators/{delta,reference,confirm}.ts` and their tests.

- `delta` — compares against the previous invoice on `spec.field` (`item_present`, `amount`, `section_total`) with an optional `spec.changeAtLeastPct`. Item identity across invoices is the hard part: use `normalizeDescription`, and remember its documented limits — a purely numeric token is dropped, so two lines differing only by a number normalise identically. Decide what that means for `item_present` and say so.
- `reference` — compares against `ctx.references` for `aneel_tariff`, `aneel_flag` or `cdc_limits` within `spec.tolerancePct`. §12.3's RN-040 names the traps explicitly: filter `DscBaseTarifa = "Tarifa de Aplicação"`; the table is in R$/MWh; gross up taxes as `tarifa_com = tarifa_sem / (1 − (pis+cofins)) / (1 − icms)`; read PIS and COFINS from the invoice, never fixed; pro-rate when a tariff revision falls mid-cycle; join by CNPJ, never by an acronym. **The dedicated regression test §12.3 demands for the `DscBaseTarifa` filter is required.** With no reference data supplied, the evaluator produces nothing rather than comparing against zero.
- `confirm` — turns an uncertain match into a question. When `ctx.answers` already holds the user's answer, `spec.onNo` decides whether a finding is created. Unanswered, it produces a finding carrying `askUser`, and RF-124 governs whether that is shown.

Positive and negative test each (RF-121), plus: a delta with no previous invoice; a reference with no data; a confirm whose answer is already recorded both ways.

---

### Task 3: The suppressor, and `INV-010` as a property of the engine

**Files:** `packages/core/src/rules/evaluators/suppressor.ts` and its test; extend `packages/db/test/invariants/suppressors.spec.ts`.

The `suppressor` kind removes findings that other rules produced, per `spec.blocks` and with `spec.reason`. It runs **after** every other evaluator, and what it removes is recorded rather than silently dropped — a dead thesis suppressed invisibly is indistinguishable from a rule that never fired.

Seed the three suppressors of §12.4 as `active` rules: `RN-090` (ICMS over TUSD/TUST — STJ Tema 986 settled it), `RN-091` (COSIP without a lamppost), `RN-092` (minimum water tariff per economia — STJ revised Tema 414). Each carries the reason the PRD gives.

**The invariant to add:** today `invariants/suppressors.spec.ts` checks that no rule *named* after a dead thesis is active. That is a name check. Add the stronger property: run the engine over a fixture invoice carrying each dead thesis's shape, with the suppressors seeded, and assert no finding survives for any of them. A rule that signals ICMS over TUSD under an unrelated slug must still be suppressed. Prove it by seeding exactly such a rule and watching the assertion fail without the suppressor.

---

### Task 4: The engine — ordering, precedence, thresholds, clustering

**Files:** `packages/core/src/rules/engine.ts`; its test.

`runRules` stops throwing and starts working. It must:

1. select the rules that apply — the category's, plus the issuer's
2. apply **RF-123 precedence**: an issuer-specific rule outranks the generic rule of the same `slug`, and only the specific one's finding is created
3. run every evaluator, then the suppressors
4. apply **RF-124's thresholds**: below 0,55 no visible finding is created — it becomes a question; 0,55 to 0,8 is "verificar"; above 0,8 is "provável cobrança a contestar"
5. apply **RF-128 clustering**: three or more findings in the same section and cycle produce one aggregate finding, which the report shows first
6. enforce **RF-129**: reject any finding without evidence or without legal basis

The order matters and each step depends on the one before. State it in the doc comment so the next reader does not have to derive it.

RF-120's acceptance is that it is pure and deterministic: **test that the same input produces an identical result across repeated runs, and that the input is not mutated.**

The aggregate finding of RF-128 has an acceptance example: five SVAs show as "R$ 51,60 em 5 serviços digitais" above the individual lines. The wording a user sees must pass the forbidden-term lint.

---

### Task 5: The deterministic rules of §12.1 as seeded configuration

**Files:** `packages/db/src/seeds/rules/deterministic.ts`; its test; extend `packages/db/src/seeds/index.ts`.

Seed RN-001 to RN-011 as rule rows. Each carries its `spec`, its `legalBasis` from the PRD's own citation, its `confidenceBase`, and `status: "shadow"` — **not `active`**, because RF-125 says a new rule enters shadow, and these have never seen a real invoice.

Read §12.1 for each; they are fully specified there. The ones with real arithmetic:

- **RN-001** the fine's base excludes COSIP, accessory services and prior penalties; fine ≤ 2%, interest ≤ 1% a.m. *pro rata die* (REN 1.000 art. 343)
- **RN-003** the availability cost is the **greater of** the minimum and consumption, never the sum; minimums 30/50/100 kWh by phase; does not apply below a 27-day cycle (REN 1.000 art. 655-I)
- **RN-004** water: `current − previous ≠ consumption`, or current below previous with no meter change
- **RN-007** the 100% ceiling on card charges for debts originating from 01/01/2024 (Lei 14.690/2023)
- **RN-010** free essential services: more than 4 withdrawals a month, 2 statements (Res. CMN 3.919/2010)
- **RN-011** a package priced above the sum of its individual tariffs

Each rule gets a fixture invoice exercising it — one that fires and one that does not. A seeded rule with no test is a rule nobody has ever seen work.

---

### Task 6: The pattern rules of §12.2 that do not need the lexicon

**Files:** `packages/db/src/seeds/rules/pattern.ts`; its test.

Seed, as `shadow`:

- **RN-020's section-anchored half** — an item in one of the issuer's own §20.1 section names, absent from the previous invoice. Task 5 of E1 seeded those section names on `issuers.sections`. Confidence base 0,80, or 0,88 when the section is the confirmed anchor. The lexicon half of this rule is out of scope; say so in the seed's comment so nobody thinks the rule is complete.
- **RN-024** a charge whose period is after a cancellation date the user gave (Decreto 11.034 art. 14 II) — a `confirm` rule, since only the user knows the date
- **RN-025** a fine above 2% or interest above 1% a.m. (CDC art. 52 §1º)
- **RN-026** the same description and value twice in one cycle

RN-021 and RN-023 are **not** seeded; record why in the file's header, naming `CLAUDE.md` §7.

---

### Task 7: Loading rules and recording findings

**Files:** `packages/db/src/rules.ts`; `apps/jobs/src/tasks/ingest.ts`; tests.

The ingest task currently calls `runRules` with a hard-coded empty rule list and **throws if it ever returns a finding** — a guard that made sense when no rule existed and now stands between E2 and working. Replace it.

- load the `active` and `shadow` rules for the invoice's category and issuer
- pass them, plus any reference data and the user's recorded answers, into `runRules`
- persist the findings, with `shadow` set from the rule that produced them
- record the events

**RF-125's acceptance is that a shadow finding does not appear in `/report`.** `findingsForInvoice` in `withUser` has no `shadow` filter today, and the report route computes its totals over whatever it returns — so a shadow finding would both show and be counted. Fix both, and test that a shadow finding is invisible to the report and visible to an admin query.

---

### Task 8: Rule metrics, automatic promotion and automatic pause

**Files:** `apps/jobs/src/tasks/rule-metrics.ts`, `apps/jobs/src/tasks/rule-lifecycle.ts`; tests; registration in `apps/web/lib/container.ts`.

- **RF-302** a nightly job materialises `rule_metrics` from `events`. Recomputing the same day must produce the same result — test that.
- **RF-126** a `shadow` rule promotes to `active` only with `dismissed / fired < 0,15` over at least 30 firings. Below that it stays.
- **RF-127** an `active` rule with `dismissed / fired > 0,15` over 50+ firings goes to `paused` and raises an alert.

Both transitions record an event. Editing a rule creates a **new version** rather than mutating the row (RF-301): `rules` is unique on `(slug, version)`, and `rules.spec` is versioned configuration per A5. A destructive update would erase the evidence a pause was based on.

Test the boundaries exactly: 29 firings versus 30; a ratio of exactly 0,15 — decide which side the boundary falls on and say why.

---

### Task 9: Findings surfaced honestly

**Files:** `apps/web/app/api/invoices/[id]/report/route.ts`; `apps/web/app/api/findings/[id]/feedback/route.ts`; tests.

The report route already returns findings and totals. It must now:

- exclude shadow findings from both the list and the totals
- carry RF-124's band per finding, so the interface can say "verificar" or "provável cobrança a contestar" without deciding the wording itself
- put the RF-128 aggregate first
- expose `askUser` for a confirm finding

Add `POST /api/findings/:id/feedback` from §8.2, which records `dismiss` or `confirm` — this is the signal RF-126 and RF-127 run on, so without it the automatic brake has nothing to read. It goes through `withUser`: a user must not be able to dismiss another user's finding. Test that.

---

### Task 10: The `INV-006` invariant

**Files:** `packages/db/test/invariants/sensitive.spec.ts`.

`INV-006` says the system never infers or stores a sensitive category from an invoice, and §16.3 names `invariants/sensitive.spec.ts` as its suite. It has no test because until now no rule existed to constrain.

Assert that no rule — at any status — matches a term denoting health, religion, union membership or political affiliation, and that the engine produces no finding keyed on one. Build the vocabulary explicitly and in Portuguese, since that is the language invoices are written in, and match accent-insensitively. Prove the suite fires by seeding exactly such a rule and watching it fail.

---

## Self-review notes

**Coverage.** RF-120 → Task 4. RF-121 → Tasks 1, 2, 3. RF-122 shipped in E1. RF-123, RF-124, RF-128, RF-129 → Task 4. RF-125 → Tasks 6, 7. RF-126, RF-127, RF-301, RF-302 → Task 8. §12.1 → Task 5. §12.2's lexicon-free half → Task 6. §12.4 → Task 3. `INV-006` → Task 10. `INV-010` → Task 3.

**The two decisions a reviewer should press on.** Tasks 1 and 2 define an expression language for `threshold` and `arithmetic`; a rule row is edited through an admin panel, so anything evaluable there is an execution path and `eval` would be a remote code execution hole. And Task 8's boundaries — 30 firings, 0,15 — decide when a rule starts showing findings to real people; an off-by-one there is a rule promoted on thinner evidence than the PRD intends.
