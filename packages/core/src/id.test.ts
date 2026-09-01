import { describe, expect, it } from "vitest";
import { newId, newPublicToken } from "./id.js";

describe("newId", () => {
  it("prefixes the id with the semantic prefix and an underscore", () => {
    expect(newId("inv")).toMatch(/^inv_/);
  });

  it("produces a 21 character body after the prefix", () => {
    const id = newId("cas");
    expect(id.slice("cas_".length)).toHaveLength(21);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("rul")));
    expect(ids.size).toBe(1000);
  });
});

// A capability token for a public, unauthenticated surface (RF-145's card,
// and RF-146's /l/[token] laudo page once that ships) is deliberately not a
// `newId(...)` value: `newId` always carries a semantic prefix that names
// the table the id belongs to, and every one of its ids is also used as a
// plain resource identifier throughout authenticated routes, logs, and
// events - reasonable places for a *resource id* to turn up, but not places
// a *bearer secret* should. `newPublicToken` has no prefix (so it cannot be
// mistaken for, or trivially correlated with, any table's id namespace) and
// a longer body (32 vs. 21 chars) than `newId`, since it is meant to stand
// on its own as the only thing gating access to a session-less route.
describe("newPublicToken", () => {
  it("produces a 32 character token", () => {
    expect(newPublicToken()).toHaveLength(32);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newPublicToken()));
    expect(tokens.size).toBe(1000);
  });
});
