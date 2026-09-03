import { describe, expect, it } from "vitest";
import { validateRuleDraft, type RuleDraftInput } from "@pentefino/core";
import { DETERMINISTIC_RULES } from "./deterministic.js";
import { LEXICON_RULES } from "./lexicon.js";
import { SUPPRESSOR_RULES } from "./suppressors.js";

/**
 * `seedDeterministicRules`/`seedLexiconRules`/`seedSuppressorRules`
 * (`deterministic.ts`/`lexicon.ts`/`suppressors.ts`) each write their
 * catalogue straight through `db.insert(rules).values(...)` — none of them
 * calls `validateRuleDraft`, unlike an admin-authored row created through
 * `createRuleVersion` (`packages/db/src/admin.ts`). A previous fix report
 * claimed "packages/db's full run includes every seeded rule round-tripping
 * through the now-stricter validateRuleDraft"; that was never true — the
 * seeds have no code path that calls it — even though the underlying claim
 * (every seeded rule *would* pass) checked out by hand at the time.
 *
 * This test is that hand-check, made permanent: every entry of all three
 * seed catalogues, reassembled into a `RuleDraftInput` from the exact
 * `category`/`spec`/`legalBasis`/`confidenceBase`/`reason` values the seed
 * itself ships, must come back `{ ok: true }`. `author` has no field on any
 * of the three catalogue entry types (each seed file applies its own
 * module-level `AUTHOR` constant only at insert time) and `validateRuleDraft`
 * only requires it non-empty, so a fixed placeholder stands in for it here
 * without weakening what is actually being pinned. `issuerId` is likewise
 * always `null` for every seeded rule (none of these three catalogues is
 * issuer-specific), matching what each `seed*Rules` function actually
 * inserts.
 *
 * Pinning this means a future tightening of `validateRuleDraft` (a new
 * required field, a stricter enum) that would reject a rule this codebase
 * already ships fails here, in CI — not silently, the next time someone
 * happens to create a new version of that exact slug through the real admin
 * panel, or never.
 */
describe("seed catalogues round-trip through validateRuleDraft", () => {
  const AUTHOR_PLACEHOLDER = "seed-catalogue-test";

  const deterministicInputs: [string, RuleDraftInput][] = DETERMINISTIC_RULES.map((rule) => [
    `DETERMINISTIC_RULES: ${rule.slug}`,
    {
      slug: rule.slug,
      category: rule.category,
      issuerId: null,
      kind: rule.spec.kind,
      spec: rule.spec,
      legalBasis: rule.legalBasis,
      confidenceBase: rule.confidenceBase,
      author: AUTHOR_PLACEHOLDER,
      reason: rule.reason,
    },
  ]);

  const lexiconInputs: [string, RuleDraftInput][] = LEXICON_RULES.map((rule) => [
    `LEXICON_RULES: ${rule.slug}`,
    {
      slug: rule.slug,
      category: rule.category,
      issuerId: null,
      kind: rule.spec.kind,
      spec: rule.spec,
      legalBasis: rule.legalBasis,
      confidenceBase: rule.confidenceBase,
      author: AUTHOR_PLACEHOLDER,
      reason: rule.reason,
    },
  ]);

  // `SuppressorRule` has no `legalBasis` field — `seedSuppressorRules` always
  // inserts `legalBasis: []` for every row (see that file's own doc comment
  // on why: no `LegalRef.effect` value can honestly describe a thesis
  // settled *against* the consumer). `validateRuleDraft` exempts `kind ===
  // "suppressor"` from check 8's "at least one legalBasis entry" requirement
  // for the same reason, so `[]` here is both accurate and expected to pass.
  const suppressorInputs: [string, RuleDraftInput][] = SUPPRESSOR_RULES.map((rule) => [
    `SUPPRESSOR_RULES: ${rule.slug}`,
    {
      slug: rule.slug,
      category: rule.category,
      issuerId: null,
      kind: rule.spec.kind,
      spec: rule.spec,
      legalBasis: [],
      confidenceBase: rule.confidenceBase,
      author: AUTHOR_PLACEHOLDER,
      reason: rule.reason,
    },
  ]);

  it("has a non-empty catalogue of each kind (a truthy count, not a vacuously-passing empty loop)", () => {
    expect(deterministicInputs.length).toBeGreaterThan(0);
    expect(lexiconInputs.length).toBeGreaterThan(0);
    expect(suppressorInputs.length).toBeGreaterThan(0);
  });

  it.each([...deterministicInputs, ...lexiconInputs, ...suppressorInputs])(
    "%s passes validateRuleDraft",
    (_label, input) => {
      expect(validateRuleDraft(input)).toEqual({ ok: true });
    },
  );
});
