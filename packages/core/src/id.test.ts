import { describe, expect, it } from "vitest";
import { newId } from "./id.js";

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
