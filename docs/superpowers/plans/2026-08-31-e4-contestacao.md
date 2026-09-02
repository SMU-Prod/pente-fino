# E4 · Contestação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the text a person sends to a company about their own bill — with the legal references coming from the rules that fired, never from a model, and with the product never presenting itself as the author.

**Architecture:** The document's assembly is deterministic and lives in `packages/core`: which asks belong to the stage, which legal references the findings carry, which attachments the checklist needs. Only the prose is generated, behind the `AiProvider` port. The lint gate and the schema gate both run before anything reaches a user.

## Global Constraints

- **`INV-003`** — the user is the author. No document, template or generated string presents the system as author or representative. No institutional first-person plural ("entraremos", "representamos", "nós enviamos"). Sending is always a manual act by the person.
- **`INV-004` / `INV-005`** — §14.3's vocabulary, enforced by `lintUserFacingText`, before display and not after generation. `packages/ai` already implements it, including plurals, multi-word terms across any whitespace, and the explicit-citation mechanism.
- **`INV-002`** — the product never sends anything anywhere on the user's behalf. It produces text and a deep link.
- **A7** — every model call returns an object validated by Zod. **A8** — when it cannot, it says so.
- Money is integer cents. ESM with `verbatimModuleSyntax`. English code, identifiers and commits; every user-facing and document string in pt-BR. Windows locally, Linux in CI.

**What already exists:** `ContestDocument` (§7.5) in `packages/core`; `Playbook` and `Stage` types, and §20.2's telecom playbook in the PRD; `Finding` carrying `legalBasis`; `lintUserFacingText` with `LintOptions.citations`; the `AiProvider` port and its gateway adapter, selected when `AI_GATEWAY_API_KEY` is set; the `prompts` table with the v1 extraction prompt seeded, and the pattern for seeding a versioned prompt; `case_documents` in the schema with `body`, `userEdited`, `editedBody` and `promptVersion`.

---

### Task 1: The deterministic half of a contestation

**Files:** `packages/core/src/documents/assemble.ts` and its tests.

Everything about a contestation that is not prose. Given the findings, the stage, the playbook and any protocols already recorded, produce the structured input a generator will turn into text — and the parts that must never be generated at all.

- **RF-161's legal references.** Collected from the findings' own `legalBasis`, deduplicated, never invented. This function is the only source; the generator receives them and may not add to them.
- **RF-165's attachment checklist**, derived from the stage. §20.2's playbook is the shape; the acceptance names `consumidor_gov` needing the invoice, the previous protocol and a screenshot of the conversation.
- **The stage's asks**, from the playbook — §20.2 lists them per stage, and they are requirements of the document, not suggestions to a model.
- **RF-163's mandatory script items**: asking for the protocol number and for the call recording are required, whatever else the script says.

Pure, no I/O, and it is what makes RF-161's acceptance test possible: inject findings carrying legal basis X, assert only X comes out.

---

### Task 2: The generator, its two gates, and its refusal

**Files:** `packages/ai/src/contest.ts`, the seeded prompt, tests.

RF-160: structured input in, a validated `ContestDocument` out. Two gates, in order, and a refusal that is honest.

1. **Schema gate.** A response that does not satisfy `ContestDocument` is rejected and regenerated **once**. Failing again is a clear error to the user, never a partial document.
2. **Lint gate (RF-162).** `lintUserFacingText` runs on every string the document can show — `subject`, `body`, each `request`, each `scriptForCall` line, each attachment label — **before display**. A document containing "advogado" is rejected and regenerated. Write the forced fixture the acceptance asks for.

**The legal references are not generated.** They are attached from Task 1's output after generation, and the prompt must not ask for them. Assert this the way RF-161's acceptance says: findings with basis X in, only X out.

**The prompt is a versioned row** (A5), like the extraction prompt — seeded, not a literal. It must instruct the model that the author is the person, not the system (`INV-003`), and it must not ask for a legal citation.

**Without a key the generator refuses visibly** and never assembles prose from templates. A document stitched from fixed fragments looks finished and is not, and this one gets sent to a company.

---

### Task 3: `INV-003` as a suite

**Files:** `packages/ai/test/invariants/authorship.spec.ts`; extend the invariants README.

§16.3 names this file and it has never existed, because until now there was no document to constrain. §3 says the check is *"ausência de primeira pessoa do plural institucional em templates"*.

Build the vocabulary in Brazilian Portuguese — that is the language these documents are written in — and think about what an institutional "we" actually looks like in a complaint: verbs conjugated in the first person plural that place the system in the procedure, and phrases that assert representation. Distinguish those from a legitimate first person: the **person** writing "solicito" or "não reconheço" is the whole point, and a check that flags those would be worse than none.

Assert it over the seeded prompt, over Task 1's deterministic strings, and over a generated document fixture. **Prove it fires** by feeding it a document written in the institutional voice.

---

### Task 4: Persisting a document, and preserving what the person changed

**Files:** `packages/db/src/documents.ts` or an addition to `withUser`; `apps/web` routes for generating and editing; tests.

RF-164: a document is editable; editing sets `userEdited` and keeps the original. Both versions stay readable. `case_documents` already has `body`, `editedBody`, `userEdited` and `promptVersion`.

This is `INV-003` in the data model, not just in the text: the record shows whether the words the person sent were theirs or the generator's, and that distinction is the reason the field exists.

`INV-008` applies — a document belongs to a case, a case belongs to a user, and one user must not read or edit another's. The report route's existing treatment of `forbidden` versus `not_found` is the precedent.

§8.2 names `POST /api/cases/:id/documents/:docId/edit`. Note that `POST /api/cases` — creating the case a document hangs off — is also in §8.2 and does not exist yet; decide whether it belongs here or in E5, and say which.

---

### Task 5: The eval harness and §20.4's rubric

**Files:** `scripts/eval-contest.mjs` or equivalent, its tests, CI wiring.

§20.4 gives the rubric: all the playbook's asks for the stage (weight 3), only the supplied legal bases (3), zero forbidden terms (2), protocols and expired deadlines mentioned when they exist (1), length and neutral tone (1). Approval is ≥ 8/10 over a sample of 20 cases per prompt version.

Three of those five criteria are deterministic and can be scored today with no model: the asks, the legal bases, and the forbidden terms — eight of the ten points (3 + 3 + 2). Score them. The other two need generated text.

**With no key it must say it measured nothing**, the way `golden:run` does, rather than reporting a vacuous pass. §18's own gate for this block is "eval com rubrica ≥ 8/10", so a harness that quietly passes an empty sample would fake the block's definition of done.

---

## Self-review notes

**Coverage.** RF-160 → Task 2. RF-161 → Tasks 1 and 2. RF-162 → Task 2. RF-163 → Tasks 1 and 2. RF-164 → Task 4. RF-165 → Task 1. `INV-003` → Task 3. §20.4 → Task 5.

**The decision a reviewer should press on** is in Task 3: where the line falls between the person's own first person, which the document is built on, and the institutional first person that `INV-003` forbids. Too loose and the invariant is decoration; too tight and it rejects the very sentences the user needs to write.
