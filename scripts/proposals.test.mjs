// scripts/proposals.test.mjs
//
// Run with `node --test` (wired into the root `pnpm test` — see
// package.json), the same way every other scripts/*.test.mjs runs: plain
// Node, no build step, exercising exactly the execution path the CLI uses.
//
// The point of this file is the seam, not the formatting. `scripts/
// proposals.mjs` exists because `applyRulePromotionProposal` had no caller
// outside its own unit test, which meant a `shadow` rule could never become
// `active` and the report would have stayed empty forever while every test
// in the repo passed. A test that stubbed the database would reproduce that
// exact failure: green, and proving nothing about whether a rule really
// flips. So this runs against a real PGlite database with the real
// migrations and the real seeds.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-sibling-loader.mjs", import.meta.url);

const { parseArgs, formatProposal, approve, list } = await import("./proposals.mjs");
const { createTestDb, schema } = await import("../packages/db/src/testing.ts");
const { newId } = await import("../packages/core/src/id.ts");

const { agentProposals, events, rules } = schema;

let ctx;
before(async () => { ctx = await createTestDb(); });
after(async () => { await ctx?.close(); });

/** A `shadow` rule and the `pending` proposal the lifecycle job would have written for it. */
async function seedPendingPromotion(db) {
  const ruleId = newId("rul");
  await db.insert(rules).values({
    id: ruleId,
    slug: `test-promocao-${ruleId}`,
    version: 1,
    kind: "pattern",
    category: "telecom",
    status: "shadow",
    spec: { match: "TESTE" },
    legalBasis: [{ law: "CDC", article: "art. 39", effect: "abusiva" }],
    confidenceBase: 0.9,
    author: "test",
    reason: "fixture for the promotion path",
  });
  const proposalId = newId("prp");
  await db.insert(agentProposals).values({
    id: proposalId,
    kind: "promote_rule",
    target: ruleId,
    status: "pending",
    payload: { ruleId, ruleSlug: `test-promocao-${ruleId}`, ruleVersion: 1 },
    evidence: ["40 disparos, 3 descartes"],
  });
  return { ruleId, proposalId };
}

describe("pnpm proposals approve — the only path a shadow rule has to reach a user", () => {
  test("flips the rule to active, so its findings stop being invisible", async () => {
    const { db } = ctx;
    const { ruleId, proposalId } = await seedPendingPromotion(db);

    const before = (await db.select().from(rules)).find((r) => r.id === ruleId);
    assert.equal(before.status, "shadow", "precondition: the rule starts in shadow");

    await approve(db, proposalId, "erick", "revisado à mão");

    const after = (await db.select().from(rules)).find((r) => r.id === ruleId);
    assert.equal(after.status, "active");
  });

  test("records who decided it, because an anonymous promotion is not a decision", async () => {
    const { db } = ctx;
    const { proposalId } = await seedPendingPromotion(db);

    await approve(db, proposalId, "erick", "revisado à mão");

    const row = (await db.select().from(agentProposals)).find((p) => p.id === proposalId);
    assert.equal(row.status, "approved");
    assert.equal(row.decidedBy, "erick");
  });

  test("writes a rule_promoted event, so A3 can reconstruct when the rule went live", async () => {
    const { db } = ctx;
    const { ruleId, proposalId } = await seedPendingPromotion(db);

    await approve(db, proposalId, "erick");

    const promoted = (await db.select().from(events))
      .filter((e) => e.type === "rule_promoted")
      .filter((e) => JSON.stringify(e.payload ?? {}).includes(ruleId));
    assert.equal(promoted.length, 1);
  });

  test("refuses to apply the same proposal twice", async () => {
    const { db } = ctx;
    const { proposalId } = await seedPendingPromotion(db);

    await approve(db, proposalId, "erick");
    await assert.rejects(() => approve(db, proposalId, "erick"), /already "approved"/);
  });

  test("refuses a proposal id that does not exist, rather than reporting success", async () => {
    const { db } = ctx;
    await assert.rejects(() => approve(db, "prp_naoexiste000000000", "erick"), /no agent_proposals row/);
  });
});

describe("pnpm proposals list", () => {
  test("says plainly that nothing is pending, instead of printing silence", async () => {
    const { db } = ctx;
    const printed = [];
    const original = console.log;
    console.log = (...args) => printed.push(args.join(" "));
    try {
      await list(db, false);
    } finally {
      console.log = original;
    }
    const output = printed.join("\n");
    // Whatever else it says, an empty listing must not be mistakable for
    // "every rule is already promoted".
    assert.match(output, /pendente|shadow/i);
  });
});

describe("argument parsing", () => {
  test("reads a flag with a value and a bare flag", () => {
    const { positional, flags } = parseArgs(["approve", "prp_1", "--by", "erick", "--all"]);
    assert.deepEqual(positional, ["approve", "prp_1"]);
    assert.equal(flags.by, "erick");
    assert.equal(flags.all, true);
  });

  test("does not swallow the next flag as a value", () => {
    const { flags } = parseArgs(["list", "--all", "--by", "erick"]);
    assert.equal(flags.all, true);
    assert.equal(flags.by, "erick");
  });
});

describe("formatting", () => {
  test("shows the evidence the lifecycle job recorded, which is what a human decides on", () => {
    const text = formatProposal({
      id: "prp_1",
      status: "pending",
      kind: "promote_rule",
      createdAt: new Date("2026-09-01T12:00:00Z"),
      payload: { ruleId: "rul_1" },
      evidence: ["40 disparos, 3 descartes"],
    });
    assert.match(text, /prp_1/);
    assert.match(text, /40 disparos, 3 descartes/);
    assert.match(text, /rul_1/);
  });
});
