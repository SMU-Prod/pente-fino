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

const { agentProposals, anonymousSessions, events, rules, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { GET: listProposals } = await import("../../app/api/admin/proposals/route.js");
const { POST: decideProposal } = await import("../../app/api/admin/proposals/[id]/route.js");

const SECRET = "admin-proposals-test-secret";
const ADMIN_EMAIL = "admin@example.com";

const NOT_FOUND_BODY = { error: { code: "not_found", message: "Não encontramos esse item." } };

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;

const adminUserId = newId("usr");
const otherUserId = newId("usr");
const sessionAdmin = "ses_admin00000000000000";
const sessionOther = "ses_other00000000000000";

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-admin-proposals-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-admin-proposals-mail-"));
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

/** A `shadow` rule with a real 30-firing, sub-15%-dismissal record — exactly what RF-126 would have proposed. */
async function insertShadowRule(slug: string) {
  const id = newId("rul");
  await ctx.db.insert(rules).values({
    id, slug, version: 1, category: "telecom", issuerId: null, kind: "pattern",
    spec: { kind: "pattern", match: "TESTE" }, legalBasis: [{ law: "CDC", article: "39", effect: "dobro" }],
    confidenceBase: 0.8, status: "shadow", shadowUntil: new Date(),
    author: "system", reason: "fixture",
  });
  const [row] = await ctx.db.select().from(rules).where(eq(rules.id, id));
  if (!row) throw new Error("insertShadowRule: insert failed");
  return row;
}

async function insertPendingPromotionProposal(ruleId: string) {
  const id = newId("prp");
  await ctx.db.insert(agentProposals).values({
    id, kind: "promote_rule", target: ruleId, payload: { ruleId },
    evidence: ["fired=30", "dismissed=2", "ratio=2/30"],
  });
  return id;
}

describe("admin gate", () => {
  it("GET /api/admin/proposals 404s with no session cookie", async () => {
    useCookies(noCookie());
    const res = await listProposals(new Request("http://localhost/api/admin/proposals"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("GET /api/admin/proposals 404s for a valid non-admin session", async () => {
    useCookies(nonAdminCookie());
    const res = await listProposals(new Request("http://localhost/api/admin/proposals"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("GET /api/admin/proposals 404s when ADMIN_EMAILS is unset, even for an otherwise-valid admin session", async () => {
    delete process.env.ADMIN_EMAILS;
    useCookies(adminCookie());
    const res = await listProposals(new Request("http://localhost/api/admin/proposals"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND_BODY);
  });

  it.each([
    ["no session cookie", noCookie],
    ["a valid non-admin session", nonAdminCookie],
  ])(
    "POST /api/admin/proposals/:id 404s for %s, and leaves the proposal pending and the rule untouched",
    async (_label, cookieFor) => {
      const rule = await insertShadowRule("rn-gate-decide");
      const proposalId = await insertPendingPromotionProposal(rule.id);
      useCookies(cookieFor());

      const res = await decideProposal(
        postRequest(`http://localhost/api/admin/proposals/${proposalId}`, { decision: "approve", reason: "x" }),
        { params: Promise.resolve({ id: proposalId }) },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND_BODY);

      const [proposal] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
      expect(proposal?.status).toBe("pending");
      const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
      expect(after?.status).toBe("shadow");
    },
  );

  it("POST /api/admin/proposals/:id 404s when ADMIN_EMAILS is unset, and leaves the proposal pending and the rule untouched", async () => {
    const rule = await insertShadowRule("rn-gate-decide-unset");
    const proposalId = await insertPendingPromotionProposal(rule.id);
    delete process.env.ADMIN_EMAILS;
    useCookies(adminCookie());

    const res = await decideProposal(
      postRequest(`http://localhost/api/admin/proposals/${proposalId}`, { decision: "approve", reason: "x" }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(res.status).toBe(404);

    const [proposal] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    expect(proposal?.status).toBe("pending");
    const [after] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(after?.status).toBe("shadow");
  });
});

describe("GET /api/admin/proposals", () => {
  it("lists only pending proposals by default, and includes decided ones with ?all=1", async () => {
    const pendingRule = await insertShadowRule("rn-lista-pendente");
    const decidedRule = await insertShadowRule("rn-lista-decidida");
    const pendingId = await insertPendingPromotionProposal(pendingRule.id);
    const decidedId = newId("prp");
    await ctx.db.insert(agentProposals).values({
      id: decidedId, kind: "promote_rule", target: decidedRule.id, payload: { ruleId: decidedRule.id },
      evidence: [], status: "rejected", decidedBy: ADMIN_EMAIL, decisionReason: "x",
    });

    useCookies(adminCookie());
    const defaultRes = await listProposals(new Request("http://localhost/api/admin/proposals"));
    expect(defaultRes.status).toBe(200);
    const defaultBody = await defaultRes.json();
    expect(defaultBody.proposals.map((p: { id: string }) => p.id)).toEqual([pendingId]);

    const allRes = await listProposals(new Request("http://localhost/api/admin/proposals?all=1"));
    const allBody = await allRes.json();
    expect(allBody.proposals.map((p: { id: string }) => p.id).sort()).toEqual([decidedId, pendingId].sort());
  });
});

// --- The gate. PRD §18's acceptance criterion for the whole of block E11:
// approving a promotion proposal is the one thing that must actually work
// end to end through this HTTP surface — rule flips to active, and both the
// automatic-transition event (`rule_promoted`) and the human-decision event
// (`proposal_decided`) land in `events`. Everything else in this file is
// necessary; this is the test the block was built for.

describe("POST /api/admin/proposals/:id — decision: approve", () => {
  it("flips the rule to active and writes both a rule_promoted and a proposal_decided event", async () => {
    const rule = await insertShadowRule("rn-promovida");
    const proposalId = await insertPendingPromotionProposal(rule.id);
    useCookies(adminCookie());

    const res = await decideProposal(
      postRequest(`http://localhost/api/admin/proposals/${proposalId}`, {
        decision: "approve",
        reason: "Ratio consistentemente baixo, 30+ disparos.",
      }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(res.status).toBe(200);

    const [ruleRow] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(ruleRow?.status).toBe("active");

    const promoted = await ctx.db.select().from(events).where(eq(events.type, "rule_promoted"));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.payload).toMatchObject({ ruleId: rule.id, ruleSlug: rule.slug, ruleVersion: rule.version });

    const decided = await ctx.db.select().from(events).where(eq(events.type, "proposal_decided"));
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({
      proposalId, ruleId: rule.id, decidedBy: ADMIN_EMAIL, status: "approved",
      decisionReason: "Ratio consistentemente baixo, 30+ disparos.",
    });

    const [proposalRow] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    expect(proposalRow?.status).toBe("approved");
    expect(proposalRow?.decidedBy).toBe(ADMIN_EMAIL);
  });

  // Mirrors admin-rules.test.ts's "creates version 1, authored by the
  // admin's e-mail from the session — never a body field": `decidedBy` is
  // always the authenticated admin's e-mail, never a value the request body
  // gets to claim — a spoofed `decidedBy` here would make the append-only
  // decision history (global constraint 6) record who the caller *said*
  // decided, not who actually did.
  it("decidedBy is the admin's e-mail from the session, never a spoofed body field", async () => {
    const rule = await insertShadowRule("rn-decidedby-spoof");
    const proposalId = await insertPendingPromotionProposal(rule.id);
    useCookies(adminCookie());

    const res = await decideProposal(
      postRequest(`http://localhost/api/admin/proposals/${proposalId}`, {
        decision: "approve",
        reason: "Ratio consistentemente baixo, 30+ disparos.",
        decidedBy: "attacker@example.com",
      }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(res.status).toBe(200);

    const [proposalRow] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    expect(proposalRow?.decidedBy).toBe(ADMIN_EMAIL);

    const decided = await ctx.db.select().from(events).where(eq(events.type, "proposal_decided"));
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({ proposalId, decidedBy: ADMIN_EMAIL });
  });

  it("returns 409 the second time the same proposal is approved, and does not double-write events", async () => {
    const rule = await insertShadowRule("rn-promovida-duas-vezes");
    const proposalId = await insertPendingPromotionProposal(rule.id);
    useCookies(adminCookie());

    const first = await decideProposal(
      postRequest(`http://localhost/api/admin/proposals/${proposalId}`, { decision: "approve", reason: "primeira" }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(first.status).toBe(200);

    const second = await decideProposal(
      postRequest(`http://localhost/api/admin/proposals/${proposalId}`, { decision: "approve", reason: "segunda" }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("proposal_conflict");

    const promoted = await ctx.db.select().from(events).where(eq(events.type, "rule_promoted"));
    expect(promoted).toHaveLength(1);
    // Only the first decision's event exists — the payload still names the
    // first call's reason, never the second's.
    const decided = await ctx.db.select().from(events).where(eq(events.type, "proposal_decided"));
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({ proposalId, decisionReason: "primeira" });
  });
});

describe("POST /api/admin/proposals/:id — decision: reject", () => {
  it("writes proposal_decided with status rejected and leaves rules.status at shadow", async () => {
    const rule = await insertShadowRule("rn-rejeitada");
    const proposalId = await insertPendingPromotionProposal(rule.id);
    useCookies(adminCookie());

    const res = await decideProposal(
      postRequest(`http://localhost/api/admin/proposals/${proposalId}`, {
        decision: "reject",
        reason: "Ratio ainda incerto, poucos dias de dados.",
      }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(res.status).toBe(200);

    const [ruleRow] = await ctx.db.select().from(rules).where(eq(rules.id, rule.id));
    expect(ruleRow?.status).toBe("shadow");

    const [proposalRow] = await ctx.db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    expect(proposalRow?.status).toBe("rejected");
    expect(proposalRow?.decidedBy).toBe(ADMIN_EMAIL);

    const decided = await ctx.db.select().from(events).where(eq(events.type, "proposal_decided"));
    expect(decided).toHaveLength(1);
    expect(decided[0]?.payload).toMatchObject({ proposalId, status: "rejected", decidedBy: ADMIN_EMAIL });

    // No rule_promoted event either — a rejection changes no rule.
    const promoted = await ctx.db.select().from(events).where(eq(events.type, "rule_promoted"));
    expect(promoted).toHaveLength(0);
  });
});
