import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runRules, type ActiveRule } from "@pentefino/core";
import type { InvoiceCanonical } from "@pentefino/core";
import { lintUserFacingText } from "../../src/lint.js";

/**
 * `packages/core` must never depend on `packages/ai` — the dependency runs
 * the other way (`packages/ai/package.json` declares
 * `"@pentefino/core": "workspace:*"`; `packages/core/package.json` declares
 * no such thing back). That means `engine.ts` cannot call
 * `lintUserFacingText` itself to prove its own wording is safe — doing so
 * would create exactly the dependency edge this architecture forbids.
 *
 * This file is the other side of that boundary. It lives inside
 * `packages/ai`, which already legitimately depends on `@pentefino/core`,
 * so it can import both without adding any new edge to the dependency
 * graph — the check happens from the layer that is allowed to know about
 * both, not from the one that must not. It runs the real engine (RF-128's
 * clustering in particular, since the aggregate finding's evidence text is
 * composed inside `engine.ts` itself — see `buildAggregateFinding` — not
 * copied from any single evaluator, so no other test file's fixtures cover
 * its exact wording) and lints every user-facing string it hands back
 * (`evidence` and `askUser.question`) against §14.2/§14.3.
 */
describe("INV-004/RF-128 · the rule engine's own user-facing text passes the forbidden-term lint", () => {
  it("packages/core declares no dependency on packages/ai (the boundary this file's placement relies on)", () => {
    const corePackageJsonUrl = new URL("../../../core/package.json", import.meta.url);
    const corePackageJson = JSON.parse(readFileSync(corePackageJsonUrl, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(corePackageJson.dependencies?.["@pentefino/ai"]).toBeUndefined();
    expect(corePackageJson.devDependencies?.["@pentefino/ai"]).toBeUndefined();
  });

  const invoice: InvoiceCanonical = {
    issuer: { name: "Claro Móvel", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 5160,
    sections: [{
      name: "Serviços Digitais",
      items: [
        { description: "SVA Turbo Wifi", amountCents: 1032 },
        { description: "SVA Cinema Play", amountCents: 1032 },
        { description: "SVA Musica Stream", amountCents: 1032 },
        { description: "SVA Games Club", amountCents: 1032 },
        { description: "SVA Noticias Plus", amountCents: 1032 },
      ],
    }],
    extraction: { confidence: 0.9, warnings: [] },
  };

  // Fires 5 times in the same section (clusters into 1 aggregate + 5
  // individual findings) — this is the PRD's own §10 RF-128 example.
  const clusterRule: ActiveRule = {
    slug: "rn-020-sva",
    version: 1,
    spec: { kind: "pattern", sections: ["Serviços Digitais"], match: "SVA" },
    confidenceBase: 0.8,
    shadow: false,
    legalBasis: [{ law: "CDC", article: "art. 39, III, p.u.", effect: "vedada" }],
    issuerId: null,
  };
  // Below RF-124's 0.55 cut: every finding it produces becomes a question.
  const questionRule: ActiveRule = {
    slug: "regra-baixa-confianca",
    version: 1,
    spec: { kind: "pattern", match: "SVA" },
    confidenceBase: 0.5,
    shadow: false,
    legalBasis: [{ law: "CDC", article: "art. 39", effect: "vedada" }],
    issuerId: null,
  };

  const findings = runRules({
    invoice, previous: null, rules: [clusterRule, questionRule], answers: {},
    references: { tariffs: [], flags: [] },
  });

  it("produces both an aggregate finding and at least one question, so the lint below is not vacuous", () => {
    expect(findings.some((f) => f.ruleSlug.startsWith("cluster:"))).toBe(true);
    expect(findings.some((f) => f.askUser !== undefined)).toBe(true);
  });

  for (const [index, finding] of findings.entries()) {
    for (const [lineIndex, line] of finding.evidence.entries()) {
      it(`finding[${index}] (${finding.ruleSlug}) evidence[${lineIndex}] passes the lint: "${line}"`, () => {
        expect(lintUserFacingText(line).ok).toBe(true);
      });
    }
    if (finding.askUser !== undefined) {
      const question = finding.askUser.question;
      it(`finding[${index}] (${finding.ruleSlug}) askUser.question passes the lint: "${question}"`, () => {
        expect(lintUserFacingText(question).ok).toBe(true);
      });
    }
  }
});
