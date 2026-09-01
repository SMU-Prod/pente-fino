import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleContest, MANDATORY_SCRIPT_ITEMS } from "@pentefino/core";
import type { Finding, Playbook } from "@pentefino/core";
import { lintUserFacingText } from "../../src/lint.js";

/**
 * `packages/core/src/documents/assemble.ts` (E4 Task 1) authors a handful of
 * pt-BR strings of its own — the base attachment, the `consumidor_gov`-style
 * attachment items, `MANDATORY_SCRIPT_ITEMS` — that eventually reach a user
 * inside a `ContestDocument`. `lintUserFacingText` lives in `packages/ai`,
 * and `packages/core` must not depend on `packages/ai` (the edge runs the
 * other way; see the boundary check below), so `assemble.ts` cannot assert
 * this about its own output. This file is the other side of that boundary,
 * exactly like `rules-wording.spec.ts` is for the rule engine: it lives
 * inside `packages/ai`, which already legitimately depends on
 * `@pentefino/core`, so it can import both without adding any new edge to
 * the dependency graph.
 *
 * `asks` is deliberately not linted here — those strings come verbatim from
 * a `Playbook`, which is caller-supplied configuration (seeded from the PRD
 * itself), not text `assemble.ts` composes. What this file owns is the
 * prose `assemble.ts` itself is the author of.
 */
describe("INV-004/RF-161/RF-163/RF-165 · assembleContest's own strings pass the forbidden-term lint", () => {
  it("packages/core declares no dependency on packages/ai (the boundary this file's placement relies on)", () => {
    const corePackageJsonUrl = new URL("../../../core/package.json", import.meta.url);
    const corePackageJson = JSON.parse(readFileSync(corePackageJsonUrl, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(corePackageJson.dependencies?.["@pentefino/ai"]).toBeUndefined();
    expect(corePackageJson.devDependencies?.["@pentefino/ai"]).toBeUndefined();
  });

  const playbook: Playbook = {
    stages: [
      {
        stage: "consumidor_gov",
        channel: "consumidor.gov.br",
        responseDays: 10,
        businessDays: false,
        requiresPreviousProtocol: true,
        asks: ["estorno em dobro com correção"],
        legalRefs: [{ law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" }],
      },
      {
        stage: "sac",
        channel: "SAC da operadora",
        responseDays: 7,
        businessDays: false,
        requiresPreviousProtocol: false,
        asks: ["número de protocolo"],
        legalRefs: [],
      },
    ],
  };

  const finding: Finding = {
    ruleSlug: "regra-teste",
    ruleVersion: 1,
    itemId: null,
    amountCents: 1000,
    doubledCents: null,
    confidence: 0.9,
    evidence: [],
    legalBasis: [{ law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" }],
    shadow: false,
  };

  const withPreviousProtocol = assembleContest({
    findings: [finding], stage: "consumidor_gov", playbook,
  });
  const withoutPreviousProtocol = assembleContest({
    findings: [finding], stage: "sac", playbook,
  });

  it("produces a longer checklist for consumidor_gov than for sac, so the lint below is not vacuous", () => {
    expect(withPreviousProtocol.attachmentsChecklist.length).toBeGreaterThan(
      withoutPreviousProtocol.attachmentsChecklist.length,
    );
  });

  for (const [index, item] of withPreviousProtocol.attachmentsChecklist.entries()) {
    it(`attachmentsChecklist[${index}] passes the lint: "${item}"`, () => {
      expect(lintUserFacingText(item).ok).toBe(true);
    });
  }

  for (const [index, item] of withoutPreviousProtocol.attachmentsChecklist.entries()) {
    it(`attachmentsChecklist (no previous protocol)[${index}] passes the lint: "${item}"`, () => {
      expect(lintUserFacingText(item).ok).toBe(true);
    });
  }

  for (const [index, item] of MANDATORY_SCRIPT_ITEMS.entries()) {
    it(`MANDATORY_SCRIPT_ITEMS[${index}] passes the lint: "${item}"`, () => {
      expect(lintUserFacingText(item).ok).toBe(true);
    });
  }
});
