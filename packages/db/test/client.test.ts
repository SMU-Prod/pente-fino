import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anonymousSessions } from "../src/schema.js";

// Finding 3: `getUnscopedDb()` used to throw unconditionally whenever
// DATABASE_URL was unset, which contradicts E0's whole premise - "all domain
// work can proceed with no external account" - by making even a local `pnpm
// dev` fail on the first real API call. The fix keeps the throw where it
// actually matters (production must never silently fall back to a
// throwaway local database) and adds a real fallback everywhere else.
//
// Each test resets the module registry and re-imports `client.js` fresh
// (rather than reusing the top-level import), because `getUnscopedDb()`
// memoizes its result in a module-level `cached` variable - without this,
// whichever test runs first would decide what every later test in this file
// observes, regardless of the env it set up for itself.
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-db-fallback-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  delete process.env.LOCAL_DATA_ROOT;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function freshGetUnscopedDb() {
  vi.resetModules();
  const mod = await import("../src/client.js");
  return mod.getUnscopedDb;
}

describe("getUnscopedDb", () => {
  it("throws a clear error when DATABASE_URL is not set in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    const getUnscopedDb = await freshGetUnscopedDb();
    expect(() => getUnscopedDb()).toThrow(/DATABASE_URL is not set/);
  });

  it("falls back to a local PGlite database outside production instead of throwing", async () => {
    process.env.NODE_ENV = "test";
    process.env.LOCAL_DATA_ROOT = root;
    delete process.env.DATABASE_URL;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getUnscopedDb = await freshGetUnscopedDb();
    let db: ReturnType<typeof getUnscopedDb> | undefined;
    expect(() => { db = getUnscopedDb(); }).not.toThrow();
    // Drains the fallback's own pending migration before this test (and its
    // `afterEach`) tears the temp directory down out from under it - a real
    // process never does that mid-flight, but this test's cleanup would
    // otherwise race it.
    await db!.select().from(anonymousSessions);
  });

  it("announces the fallback in the log, so nobody mistakes which database they are on", async () => {
    process.env.NODE_ENV = "development";
    process.env.LOCAL_DATA_ROOT = root;
    delete process.env.DATABASE_URL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getUnscopedDb = await freshGetUnscopedDb();
    const db = getUnscopedDb();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/DATABASE_URL/);
    await db.select().from(anonymousSessions); // see the comment in the test above
  });

  it("applies the real migrations to the fallback database, so a query against it actually works", async () => {
    process.env.NODE_ENV = "test";
    process.env.LOCAL_DATA_ROOT = root;
    delete process.env.DATABASE_URL;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const getUnscopedDb = await freshGetUnscopedDb();
    const db = getUnscopedDb();

    await db.insert(anonymousSessions).values({
      id: "ses_fallback0000000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const rows = await db.select().from(anonymousSessions);
    expect(rows).toHaveLength(1);
  });
});
