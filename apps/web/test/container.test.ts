import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@pentefino/db/testing";
import { container } from "../lib/container.js";

/**
 * Task 14, finding 4: every other test in this app mocks the whole
 * `lib/container.js` module (`vi.mock("../../lib/container.js", ...)`), so
 * the real `container()` function - and specifically its injectable `db`
 * override - was never exercised by anything. This file calls the real,
 * unmocked `container()` directly.
 *
 * This must be the first call to `container()` in this test file's module
 * instance: `container()` memoizes its result for the lifetime of the
 * process (see the comment on it in `lib/container.ts`), so a call made
 * anywhere earlier in this file would already have built the singleton from
 * whatever it was given then, and this override would be silently ignored.
 */
describe("container() composition root (Task 14, finding 4)", () => {
  let ctx: TestDb;

  afterEach(async () => {
    await ctx?.close();
  });

  it("uses the injected database override instead of building a real getUnscopedDb() connection", async () => {
    ctx = await createTestDb();
    const result = container({ db: ctx.db });
    expect(result.db).toBe(ctx.db);
  });
});
