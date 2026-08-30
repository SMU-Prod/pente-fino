import { describe, expect, it } from "vitest";
import { TOKENS } from "./tokens.js";

describe("design tokens", () => {
  it("carries the light palette of §13.1", () => {
    expect(TOKENS.light.paper).toBe("#FBF8F3");
    expect(TOKENS.light.mark).toBe("#C0432A");
    expect(TOKENS.light.ok).toBe("#1F6B4F");
  });

  it("carries the dark palette of §13.1", () => {
    expect(TOKENS.dark.paper).toBe("#14100E");
    expect(TOKENS.dark.mark).toBe("#F0836A");
  });

  it("defines the same keys in both themes, so no token is theme-only", () => {
    expect(Object.keys(TOKENS.light).sort()).toEqual(Object.keys(TOKENS.dark).sort());
  });

  it("names the three typefaces of §13.1", () => {
    expect(TOKENS.fonts.display).toContain("Fraunces");
    expect(TOKENS.fonts.body).toContain("IBM Plex Sans");
    expect(TOKENS.fonts.mono).toContain("IBM Plex Mono");
  });

  it("keeps the theme-invariant deep token identical across themes, as §13.1 gives only one value", () => {
    expect(TOKENS.dark.deep).toBe(TOKENS.light.deep);
  });
});
