import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { GET: listRules, POST: createRule } = await import("../../app/api/admin/rules/route.js");
const { POST: activateRule } = await import("../../app/api/admin/rules/[id]/activate/route.js");
const { POST: pauseRule } = await import("../../app/api/admin/rules/[id]/pause/route.js");

const SECRET = "admin-rules-test-secret";
const ADMIN_EMAIL = "admin@example.com";

const NOT_FOUND_BODY = { error: { code: "not_found", message: "Não encontramos esse item." } };

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const adminUserId = newId("usr");
const otherUserId = newId("usr");
const sessionAdmin = "ses_admin00000000000000";
const sessionOther = "ses_other00000000000000";

// A real, contestable draft — RF-301's shape, verbatim. Kept as a template
// object (spread, never mutated) so every test that needs "a valid body"
// starts from the same known-good shape and only overrides what it's
// actually testing.
const DRAFT_BODY = {
  slug: "regra-admin-teste",
  category: "telecom",
  issuerId: null,
  kind: "pattern",
  spec: { kind: "pattern", match: "SVA|SEGURO" },
  legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
  confidenceBase: 0.7,
  reason: "Regra de teste para o painel administrativo.",
};

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-admin-rules-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-admin-rules-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));

  await ctx.db.insert(users).values([
    { id: adminUserId, email: ADMIN_EMAIL },
    { id: otherUserId, email: "other@example.com" },
  ]);
  await ctx.db.insert(anonymousSessions).values([
    { id: sessionAdmin, claimedByUserId: adminUserId, expiresAt: new Date(Date.now() + 60 * 60_000) },
    { id: sessionOther, claimedByUserId: otherUserId, expiresAt: new Date(Date.now() + 60 * 60_000) },
  ]);
});

afterEach(async () => {
  await ctx.close();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailRoot, { recursive: true, force: true });
  delete process.env.SESSION_SIGNING_SECRET;
  delete process.env.ADMIN_EMAILS;
  vi.restoreAllMocks();
});

function useCookies(store: MockCookieStore) {
  vi.mocked(cookies).mockImplementation(async () => jarFor(store) as never);
}

function noCookie(): MockCookieStore {
  return createCookieStore();
}
function nonAdminCookie(): MockCookieStore {
  return createCookieStore({ pf_session: signSession(sessionOther, SECRET) });
}
function adminCookie(): MockCookieStore {
  return createCookieStore({ pf_session: signSession(sessionAdmin, SECRET) });
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function draftRuleRow(slug: string) {
  const [row] = await ctx.db.select().from(rules).where(eq(rules.slug, slug));
  return row;
}

/** A minimal `rules` row at whatever status a refusal test needs — inserted directly, bypassing the route entirely. */
async function insertRuleRow(overrides: Partial<typeof rules.$inferInsert> & { slug: string }) {
  const id = overrides.id ?? newId("rul");
  await ctx.db.insert(rules).values({
    id,
    slug: overrides.slug,
    version: overrides.version ?? 1,
    category: overrides.category ?? "telecom",
    issuerId: overrides.issuerId ?? null,
    kind: overrides.kind ?? "pattern",
    spec: overrides.spec ?? { kind: "pattern", match: "TESTE" },
    legalBasis: overrides.legalBasis ?? [],
    confidenceBase: overrides.confidenceBase ?? 0.8,
    status: overrides.status ?? "draft",
    shadowUntil: overrides.shadowUntil ?? null,
    author: overrides.author ?? "system",
    reason: overrides.reason ?? "fixture",
  });
  const [row] = await ctx.db.select().from(rules).where(eq(rules.id, id));
  if (!row) throw new Error("insertRuleRow: insert failed");
  return row;
}

// --- The admin gate, on every route this file exercises. Each of the three
// failure modes must both 404 *and* prove nothing happened — a 404 alone
// would pass even if the gate were missing entirely and the underlying
// mutation just happened to also fail for some unrelated reason.

describe("admin gate", () => {
  it("GET /api/admin/rules 404s with no session cookie", async () => {
    useCookies(noCookie());
    const res = await listRules();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("GET /api/admin/rules 404s for a valid non-admin session", async () => {
    useCookies(nonAdminCookie());
    const res = await listRules();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("GET /api/admin/rules 404s when ADMIN_EMAILS is unset, even for an otherwise-valid admin session", async () => {
    delete process.env.ADMIN_EMAILS;
    useCookies(adminCookie());
    const res = await listRules();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
  });

  it.each([
    ["no session cookie", noCookie],
    ["a valid non-admin session", nonAdminCookie],
  ])("POST /api/admin/rules 404s for %s, and creates no rule", async (_label, cookieFor) => {
    useCookies(cookieFor());
    const res = await createRule(postRequest("http://localhost/api/admin/rules", DRAFT_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
    expect(await draftRuleRow(DRAFT_BODY.slug)).toBeUndefined();
  });

  it("POST /api/admin/rules 404s when ADMIN_EMAILS is unset, and creates no rule", async () => {
    delete process.env.ADMIN_EMAILS;
    useCookies(adminCookie());
    const res = await createRule(postRequest("http://localhost/api/admin/rules", DRAFT_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
    expect(await draftRuleRow(DRAFT_BODY.slug)).toBeUndefined();
  });

  it.each([
    ["no session cookie", noCookie],
    ["a valid non-admin session", nonAdminCookie],
  ])("POST /api/admin/rules/:id/activate 404s for %s, and leaves the rule draft", async (_label, cookieFor) => {
    const rule = await insertRuleRow({ slug: "rn-gate-activate", status: "draft" });
    useCookies(cookieFor());
    const res = await activateRule(
      new Request(`http://localhost/api/admin/rules/${rule.id}/activate`, { method: "POST" }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(after?.status).toBe("draft");
  });

  it("POST /api/admin/rules/:id/activate 404s when ADMIN_EMAILS is unset, and leaves the rule draft", async () => {
    const rule = await insertRuleRow({ slug: "rn-gate-activate-unset", status: "draft" });
    delete process.env.ADMIN_EMAILS;
    useCookies(adminCookie());
    const res = await activateRule(
      new Request(`http://localhost/api/admin/rules/${rule.id}/activate`, { method: "POST" }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(404);
    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(after?.status).toBe("draft");
  });

  it.each([
    ["no session cookie", noCookie],
    ["a valid non-admin session", nonAdminCookie],
  ])("POST /api/admin/rules/:id/pause 404s for %s, and leaves the rule active", async (_label, cookieFor) => {
    const rule = await insertRuleRow({ slug: "rn-gate-pause", status: "active" });
    useCookies(cookieFor());
    const res = await pauseRule(
      postRequest(`http://localhost/api/admin/rules/${rule.id}/pause`, { reason: "x" }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(after?.status).toBe("active");
  });

  it("POST /api/admin/rules/:id/pause 404s when ADMIN_EMAILS is unset, and leaves the rule active", async () => {
    const rule = await insertRuleRow({ slug: "rn-gate-pause-unset", status: "active" });
    delete process.env.ADMIN_EMAILS;
    useCookies(adminCookie());
    const res = await pauseRule(
      postRequest(`http://localhost/api/admin/rules/${rule.id}/pause`, { reason: "x" }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(404);
    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(after?.status).toBe("active");
  });
});

describe("POST /api/admin/rules", () => {
  it("creates version 1, authored by the admin's e-mail from the session — never a body field", async () => {
    useCookies(adminCookie());
    const res = await createRule(
      postRequest("http://localhost/api/admin/rules", { ...DRAFT_BODY, author: "attacker@example.com" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), slug: DRAFT_BODY.slug, version: 1 });

    const row = await draftRuleRow(DRAFT_BODY.slug);
    expect(row?.author).toBe(ADMIN_EMAIL);
    expect(row?.status).toBe("draft");
    expect(row?.shadowUntil).toBeNull();
  });

  it("creates version N+1 on an existing slug", async () => {
    useCookies(adminCookie());
    const first = await createRule(postRequest("http://localhost/api/admin/rules", DRAFT_BODY));
    expect(first.status).toBe(201);

    const second = await createRule(
      postRequest("http://localhost/api/admin/rules", { ...DRAFT_BODY, reason: "Segunda versão, outro motivo." }),
    );
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ id: expect.any(String), slug: DRAFT_BODY.slug, version: 2 });

    const versions = await ctx.db.select().from(rules).where(eq(rules.slug, DRAFT_BODY.slug));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });

  it("422s on an unsafe pattern, with the RuleDraftError problems as details, and creates no rule", async () => {
    useCookies(adminCookie());
    const res = await createRule(
      postRequest("http://localhost/api/admin/rules", { ...DRAFT_BODY, spec: { kind: "pattern", match: "(a+)+" } }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("rule_invalid");
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "spec.match", code: "unsafe_pattern" })]),
    );
    expect(await draftRuleRow(DRAFT_BODY.slug)).toBeUndefined();
  });

  // Regression: `validateRuleDraft` used to check nothing at all for the six
  // non-"pattern" `RuleSpec` kinds beyond `kind === spec.kind` — a body like
  // this one used to pass straight through both the route's loose zod shape
  // check and `validateRuleDraft`, and land in `rules` as a `draft`.
  it("422s on a structurally-invalid non-pattern spec (missing required fields), and creates no rule", async () => {
    useCookies(adminCookie());
    const res = await createRule(
      postRequest("http://localhost/api/admin/rules", {
        ...DRAFT_BODY,
        kind: "threshold",
        spec: { kind: "threshold" },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("rule_invalid");
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "spec.expr", code: "spec_expr_required" })]),
    );
    expect(await draftRuleRow(DRAFT_BODY.slug)).toBeUndefined();
  });

  // Regression: `validateSpecStructure` (packages/core/src/rules/draft.ts)
  // used to `switch (spec.kind)` with no `default`. The route's edge schema
  // only checks `spec.kind` is *a* string (`z.object({ kind: z.string()
  // }).passthrough()`), so a value outside `RuleSpec`'s seven kinds reached
  // that switch, fell through every case, and the function implicitly
  // returned `undefined` — `validateRuleDraft` then threw destructuring it,
  // which this route's `catch` swallowed into the generic `not_found` used
  // for every unrelated 404, not the 422 `rule_invalid` this is actually a
  // case of. This body's `kind: "pattern"` is a valid RULE_KINDS value —
  // only `spec.kind` is bogus — so it clears the route's `Body` zod schema
  // and reaches `validateRuleDraft`.
  it("422s (rule_invalid) on an unknown spec.kind, not the generic not_found, and creates no rule", async () => {
    useCookies(adminCookie());
    const res = await createRule(
      postRequest("http://localhost/api/admin/rules", {
        ...DRAFT_BODY,
        kind: "pattern",
        spec: { kind: "totally-bogus-kind" },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("rule_invalid");
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "spec.kind", code: "spec_kind_unknown" })]),
    );
    expect(await draftRuleRow(DRAFT_BODY.slug)).toBeUndefined();
  });
});

describe("POST /api/admin/rules/:id/activate", () => {
  it("moves a draft rule to shadow, actor is the admin's e-mail", async () => {
    const rule = await insertRuleRow({ slug: "rn-ativa-ok", status: "draft" });
    useCookies(adminCookie());

    const res = await activateRule(
      new Request(`http://localhost/api/admin/rules/${rule.id}/activate`, { method: "POST" }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(200);

    const [row] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(row?.status).toBe("shadow");
    expect(row?.shadowUntil).not.toBeNull();
  });
});

describe("POST /api/admin/rules/:id/pause", () => {
  it("pauses an active rule, decidedBy is the admin's e-mail", async () => {
    const rule = await insertRuleRow({ slug: "rn-pausa-ok", status: "active" });
    useCookies(adminCookie());

    const res = await pauseRule(
      postRequest(`http://localhost/api/admin/rules/${rule.id}/pause`, { reason: "Falso positivo recorrente." }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(200);

    const [row] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(row?.status).toBe("paused");
  });
});
