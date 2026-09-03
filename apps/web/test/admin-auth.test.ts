import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "./helpers/cookies.js";

const { anonymousSessions, users } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const { cookies } = await import("next/headers");
const { requireAdmin, parseAdminEmails } = await import("../lib/admin.js");

const SECRET = "admin-auth-test-secret";

let ctx: TestDb;

function useCookies(store: MockCookieStore) {
  vi.mocked(cookies).mockImplementation(async () => jarFor(store) as never);
}

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  delete process.env.ADMIN_EMAILS;
  ctx = await createTestDb();
});

afterEach(async () => {
  await ctx.close();
  delete process.env.SESSION_SIGNING_SECRET;
  delete process.env.ADMIN_EMAILS;
  vi.restoreAllMocks();
});

describe("parseAdminEmails", () => {
  it("returns an empty set for undefined", () => {
    expect(parseAdminEmails(undefined)).toEqual(new Set());
  });

  it("returns an empty set for an empty string", () => {
    expect(parseAdminEmails("")).toEqual(new Set());
  });

  it("splits on commas, trims, and lower-cases", () => {
    expect(parseAdminEmails("Alice@Example.com, BOB@example.com")).toEqual(
      new Set(["alice@example.com", "bob@example.com"]),
    );
  });

  it("splits on whitespace (spaces and newlines) too, and drops empty entries", () => {
    expect(parseAdminEmails("  a@x.com   b@y.com\nc@z.com,, ,d@w.com  ")).toEqual(
      new Set(["a@x.com", "b@y.com", "c@z.com", "d@w.com"]),
    );
  });
});

describe("requireAdmin", () => {
  async function seedClaimedUser(email: string): Promise<{ userId: string; sessionId: string }> {
    const userId = newId("usr");
    const sessionId = newId("ses");
    await ctx.db.insert(users).values({ id: userId, email });
    await ctx.db.insert(anonymousSessions).values({
      id: sessionId,
      claimedByUserId: userId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    return { userId, sessionId };
  }

  it("refuses a real, claimed, would-be-allowlisted user when ADMIN_EMAILS is unset", async () => {
    const { sessionId } = await seedClaimedUser("admin@example.com");
    // ADMIN_EMAILS deliberately left unset (beforeEach already deletes it).
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toBeNull();
  });

  it("refuses the same user when ADMIN_EMAILS is the empty string", async () => {
    const { sessionId } = await seedClaimedUser("admin@example.com");
    process.env.ADMIN_EMAILS = "";
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toBeNull();
  });

  it("refuses an unsigned or wrongly-signed cookie", async () => {
    const { sessionId } = await seedClaimedUser("admin@example.com");
    process.env.ADMIN_EMAILS = "admin@example.com";

    // Wrongly signed: a validly-shaped "id.signature" cookie, but signed
    // with a different secret than the app is configured with.
    useCookies(createCookieStore({ pf_session: signSession(sessionId, "some-other-secret") }));
    expect(await requireAdmin(ctx.db)).toBeNull();

    // Unsigned: no "." separator at all, so readSession has nothing to
    // verify against.
    useCookies(createCookieStore({ pf_session: sessionId }));
    expect(await requireAdmin(ctx.db)).toBeNull();
  });

  it("refuses a valid but never-claimed anonymous session, because it has no userId", async () => {
    const sessionId = newId("ses");
    await ctx.db.insert(anonymousSessions).values({
      id: sessionId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    process.env.ADMIN_EMAILS = "admin@example.com";
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toBeNull();
  });

  it("refuses a claimed session whose e-mail is not on the list", async () => {
    const { sessionId } = await seedClaimedUser("not-admin@example.com");
    process.env.ADMIN_EMAILS = "admin@example.com";
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toBeNull();
  });

  it("allows a claimed session whose e-mail IS on the list, and normalizes the returned e-mail", async () => {
    const { userId, sessionId } = await seedClaimedUser("Admin@Example.com");
    process.env.ADMIN_EMAILS = "admin@example.com";
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toEqual({ userId, email: "admin@example.com" });
  });

  it("matches the allowlist case-insensitively and ignoring surrounding whitespace, on both sides", async () => {
    const { userId, sessionId } = await seedClaimedUser("Weird.Case@Example.com");
    process.env.ADMIN_EMAILS = "  WEIRD.case@EXAMPLE.com  ";
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toEqual({ userId, email: "weird.case@example.com" });
  });

  it("refuses a soft-deleted user whose e-mail is on the list", async () => {
    const { userId, sessionId } = await seedClaimedUser("admin@example.com");
    await ctx.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, userId));
    process.env.ADMIN_EMAILS = "admin@example.com";
    useCookies(createCookieStore({ pf_session: signSession(sessionId, SECRET) }));

    const actor = await requireAdmin(ctx.db);

    expect(actor).toBeNull();
  });
});
