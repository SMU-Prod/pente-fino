import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import type { Category, Stage } from "@pentefino/core";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  agentProposals,
  aiCalls,
  anonymousSessions,
  caseDocuments,
  caseProtocols,
  cases,
  entitlements,
  findings,
  invoiceItems,
  invoices,
  issuers,
  prompts,
  referenceFlags,
  rules,
  seoPages,
  users,
} from "../src/schema.js";

let ctx: TestDb;

beforeEach(async () => { ctx = await createTestDb(); });
afterEach(async () => { await ctx.close(); });

// The number of tables PRD §6.2 defines (confirmed against the brief's
// `Produces` list and the generated migration). Any drift here means either
// a missing table or a migration that silently failed to apply.
const EXPECTED_TABLE_COUNT = 20;

// --- Fixtures for tests that need parent rows to satisfy foreign keys ---

async function seedUser(db: TestDb["db"]) {
  const id = newId("usr");
  await db.insert(users).values({ id, email: `${id}@example.com` });
  return id;
}

async function seedIssuer(db: TestDb["db"], category: Category = "telecom") {
  const id = newId("iss");
  await db.insert(issuers).values({ id, slug: id, category, displayName: "Test Issuer" });
  return id;
}

async function seedInvoice(
  db: TestDb["db"],
  owner: { userId?: string; sessionId?: string },
  issuerId: string,
) {
  const id = newId("inv");
  await db.insert(invoices).values({
    id,
    userId: owner.userId,
    sessionId: owner.sessionId,
    issuerId,
    contentHash: newId("inv"),
    source: "pdf_text",
  });
  return id;
}

async function seedRule(db: TestDb["db"]) {
  const id = newId("rul");
  await db.insert(rules).values({
    id,
    slug: id,
    category: "telecom",
    kind: "pattern",
    spec: { kind: "pattern", match: "test" },
    confidenceBase: 0.5,
    author: "system",
    reason: "test fixture",
  });
  return id;
}

async function seedCase(db: TestDb["db"], userId: string, invoiceId: string, issuerId: string) {
  const id = newId("cas");
  await db.insert(cases).values({ id, userId, invoiceId, issuerId, findingIds: [] });
  return id;
}

async function seedAnonymousSession(db: TestDb["db"]) {
  const id = newId("ses");
  await db.insert(anonymousSessions).values({
    id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return id;
}

describe("migration", () => {
  it("applies the migration: expected tables exist in the public schema", async () => {
    const rows = await ctx.db.execute(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(rows.rows).toHaveLength(EXPECTED_TABLE_COUNT);
  });

  it("creates the items_desc_trgm GIN index on invoice_items", async () => {
    const rows = await ctx.db.execute(
      `select indexdef from pg_indexes
       where tablename = 'invoice_items' and indexname = 'items_desc_trgm'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(String((rows.rows[0] as { indexdef: string }).indexdef)).toContain("gin");
  });
});

describe("schema", () => {
  it("stores and reads a user", async () => {
    const id = newId("usr");
    await ctx.db.insert(users).values({ id, email: "a@b.com" });
    const found = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(found[0]?.plan).toBe("free");
  });

  it("refuses a plan outside the check constraint", async () => {
    await expect(
      ctx.db.insert(users).values({ id: newId("usr"), email: "c@d.com", plan: "gold" }),
    ).rejects.toThrow();
  });

  it("accepts 'validating', the status §9.2 requires", async () => {
    const issuerId = newId("iss");
    await ctx.db.insert(issuers).values({
      id: issuerId, slug: "claro-movel", category: "telecom", displayName: "Claro Móvel",
    });
    const invoiceId = newId("inv");
    await expect(
      ctx.db.insert(invoices).values({
        id: invoiceId, issuerId, contentHash: "abc",
        source: "pdf_text", status: "validating",
      }),
    ).resolves.toBeTruthy();
  });

  it("enforces one invoice per owner and content hash (user_id branch)", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: "e@f.com" });
    const row = { userId, contentHash: "same", source: "pdf_text" as const };
    await ctx.db.insert(invoices).values({ id: newId("inv"), ...row });
    await expect(
      ctx.db.insert(invoices).values({ id: newId("inv"), ...row }),
    ).rejects.toThrow();
  });

  it("enforces one invoice per owner and content hash (session_id branch)", async () => {
    const sessionA = await seedAnonymousSession(ctx.db);
    const sessionB = await seedAnonymousSession(ctx.db);

    await ctx.db.insert(invoices).values({
      id: newId("inv"), sessionId: sessionA, contentHash: "same-hash", source: "pdf_text",
    });

    // Same hash, same anonymous session: must conflict.
    await expect(
      ctx.db.insert(invoices).values({
        id: newId("inv"), sessionId: sessionA, contentHash: "same-hash", source: "pdf_text",
      }),
    ).rejects.toThrow();

    // Same hash, different anonymous session: must not conflict.
    await expect(
      ctx.db.insert(invoices).values({
        id: newId("inv"), sessionId: sessionB, contentHash: "same-hash", source: "pdf_text",
      }),
    ).resolves.toBeTruthy();
  });

  it("cascades: deleting an invoice removes its invoice_items and findings", async () => {
    const userId = await seedUser(ctx.db);
    const issuerId = await seedIssuer(ctx.db);
    const invoiceId = await seedInvoice(ctx.db, { userId }, issuerId);
    const ruleId = await seedRule(ctx.db);

    const itemId = newId("itm");
    await ctx.db.insert(invoiceItems).values({
      id: itemId, invoiceId, lineNo: 1, description: "item", normalizedDesc: "item",
      amountCents: 100,
    });

    const findingId = newId("fnd");
    await ctx.db.insert(findings).values({
      id: findingId, invoiceId, itemId, ruleId, ruleVersion: 1,
      confidence: 0.9, amountCents: 100,
    });

    await ctx.db.delete(invoices).where(eq(invoices.id, invoiceId));

    const remainingItems = await ctx.db.select().from(invoiceItems).where(eq(invoiceItems.id, itemId));
    const remainingFindings = await ctx.db.select().from(findings).where(eq(findings.id, findingId));
    expect(remainingItems).toHaveLength(0);
    expect(remainingFindings).toHaveLength(0);
  });
});

// Every CHECK constraint the schema declares, exercised with one valid and
// one invalid value. This is what would have caught rules.category,
// case_documents.stage and case_protocols.stage shipping without a CHECK:
// each row below fails loudly if its column's constraint goes missing or
// its allowed-values list drifts from the schema.
type Deps = { userId: string; issuerId: string; invoiceId: string; ruleId: string; caseId: string };

type CheckCase = {
  table: string;
  column: string;
  valid: string;
  invalid: string;
  insert: (deps: Deps, value: string) => Promise<unknown>;
};

const CHECK_CASES: CheckCase[] = [
  {
    table: "users", column: "plan", valid: "premium", invalid: "gold",
    insert: (_deps, v) => ctx.db.insert(users).values({ id: newId("usr"), email: `${newId("usr")}@x.com`, plan: v }),
  },
  {
    table: "issuers", column: "category", valid: "energy", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(issuers).values({
      id: newId("iss"), slug: newId("iss"), category: v as Category, displayName: "X",
    }),
  },
  {
    table: "issuers", column: "status", valid: "paused", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(issuers).values({
      id: newId("iss"), slug: newId("iss"), category: "telecom", displayName: "X", status: v,
    }),
  },
  {
    table: "invoices", column: "source", valid: "csv", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(invoices).values({
      id: newId("inv"), issuerId: deps.issuerId, contentHash: newId("inv"), source: v,
    }),
  },
  {
    table: "invoices", column: "status", valid: "analyzed", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(invoices).values({
      id: newId("inv"), issuerId: deps.issuerId, contentHash: newId("inv"), source: "pdf_text", status: v,
    }),
  },
  {
    table: "rules", column: "category", valid: "card", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(rules).values({
      id: newId("rul"), slug: newId("rul"), category: v as Category, kind: "pattern",
      spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5, author: "system", reason: "test",
    }),
  },
  {
    table: "rules", column: "kind", valid: "delta", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(rules).values({
      id: newId("rul"), slug: newId("rul"), category: "telecom", kind: v,
      spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5, author: "system", reason: "test",
    }),
  },
  {
    table: "rules", column: "status", valid: "shadow", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(rules).values({
      id: newId("rul"), slug: newId("rul"), category: "telecom", kind: "pattern",
      spec: { kind: "pattern", match: "test" }, confidenceBase: 0.5, author: "system", reason: "test",
      status: v,
    }),
  },
  {
    table: "findings", column: "status", valid: "confirmed_by_user", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(findings).values({
      id: newId("fnd"), invoiceId: deps.invoiceId, ruleId: deps.ruleId, ruleVersion: 1,
      confidence: 0.9, amountCents: 100, status: v,
    }),
  },
  {
    table: "cases", column: "stage", valid: "sac", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(cases).values({
      id: newId("cas"), userId: deps.userId, invoiceId: deps.invoiceId, issuerId: deps.issuerId,
      findingIds: [], stage: v as Stage,
    }),
  },
  {
    table: "cases", column: "outcome", valid: "partial", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(cases).values({
      id: newId("cas"), userId: deps.userId, invoiceId: deps.invoiceId, issuerId: deps.issuerId,
      findingIds: [], outcome: v,
    }),
  },
  {
    table: "cases", column: "outcome_confirmed_by", valid: "user", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(cases).values({
      id: newId("cas"), userId: deps.userId, invoiceId: deps.invoiceId, issuerId: deps.issuerId,
      findingIds: [], outcomeConfirmedBy: v,
    }),
  },
  {
    table: "case_documents", column: "stage", valid: "sac", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(caseDocuments).values({
      id: newId("doc"), caseId: deps.caseId, stage: v as Stage, kind: "sac_script", promptVersion: 1,
      body: { subject: "x", body: "x", requests: ["x"], legalRefs: [], scriptForCall: [], attachmentsChecklist: [] },
    }),
  },
  {
    table: "case_documents", column: "kind", valid: "dossier", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(caseDocuments).values({
      id: newId("doc"), caseId: deps.caseId, stage: "draft", kind: v, promptVersion: 1,
      body: { subject: "x", body: "x", requests: ["x"], legalRefs: [], scriptForCall: [], attachmentsChecklist: [] },
    }),
  },
  {
    table: "case_protocols", column: "stage", valid: "ombudsman", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(caseProtocols).values({
      id: newId("prt"), caseId: deps.caseId, stage: v as Stage, protocolNumber: "123", channel: "phone",
      registeredAt: new Date(), responseDueAt: new Date(),
    }),
  },
  {
    table: "ai_calls", column: "purpose", valid: "extract", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(aiCalls).values({
      id: newId("aic"), purpose: v, provider: "anthropic", model: "claude", tokensIn: 1,
      tokensOut: 1, costUsd: 0.01, latencyMs: 1,
    }),
  },
  {
    table: "prompts", column: "status", valid: "active", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(prompts).values({
      id: newId("prm"), slug: newId("prm"), version: 1, body: "x", modelDefault: "claude", status: v,
    }),
  },
  {
    table: "reference_flags", column: "flag", valid: "amarela", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(referenceFlags).values({
      id: newId("flg"), competence: `20${10 + Math.floor(Math.random() * 89)}-01-01`,
      flag: v, valueCentsPer100Kwh: 100, sourceUrl: "https://example.com",
    }),
  },
  {
    table: "entitlements", column: "source", valid: "revenuecat", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(entitlements).values({
      id: newId("ent"), userId: deps.userId, plan: "premium", source: v,
    }),
  },
  {
    table: "seo_pages", column: "status", valid: "published", invalid: "bogus",
    insert: (deps, v) => ctx.db.insert(seoPages).values({
      id: newId("seo"), issuerId: deps.issuerId, chargeSlug: newId("seo"), title: "x", bodyMd: "x", status: v,
    }),
  },
  {
    table: "agent_proposals", column: "kind", valid: "pause_rule", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(agentProposals).values({
      id: newId("prp"), kind: v, target: "x", payload: {}, evidence: [],
    }),
  },
  {
    table: "agent_proposals", column: "status", valid: "approved", invalid: "bogus",
    insert: (_deps, v) => ctx.db.insert(agentProposals).values({
      id: newId("prp"), kind: "adjust_confidence", target: "x", payload: {}, evidence: [], status: v,
    }),
  },
];

describe("check constraints", () => {
  it("covers every CHECK constraint declared in the schema", () => {
    // 22 CONSTRAINT ... CHECK clauses in migrations/0000_init.sql. A drift
    // here means either a constraint shipped untested or this table drifted
    // from the schema.
    expect(CHECK_CASES).toHaveLength(22);
  });

  it.each(CHECK_CASES.map((c) => [`${c.table}.${c.column}`, c] as const))("enforces %s", async (_label, { valid, invalid, insert }) => {
    const deps: Deps = {
      userId: await seedUser(ctx.db),
      issuerId: await seedIssuer(ctx.db),
      invoiceId: "",
      ruleId: await seedRule(ctx.db),
      caseId: "",
    };
    deps.invoiceId = await seedInvoice(ctx.db, { userId: deps.userId }, deps.issuerId);
    deps.caseId = await seedCase(ctx.db, deps.userId, deps.invoiceId, deps.issuerId);

    await expect(insert(deps, valid)).resolves.toBeTruthy();
    await expect(insert(deps, invalid)).rejects.toThrow();
  });
});
