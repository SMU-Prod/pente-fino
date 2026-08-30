import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/client.js";

// getDb() must fail fast and clearly when misconfigured, rather than
// attempting a real network connection with an undefined URL. We never want
// this test opening an actual socket.
describe("getDb", () => {
  const original = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("throws a clear error when DATABASE_URL is not set", () => {
    expect(() => getDb()).toThrow(/DATABASE_URL is not set/);
  });
});
