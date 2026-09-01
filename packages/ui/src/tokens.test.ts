import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOKENS } from "./tokens.js";

const tokensCss = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

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

  // --- §13.1: the display face carries `SOFT 20 / WONK 1` as its fixed
  // identity, not a user-adjustable range. This has to live in `:root` -
  // font-variation-settings is inherited, so setting it once here reaches
  // every element that renders in Fraunces without repeating it at each of
  // laudo.module.css's four call sites, and is silently ignored by
  // whichever font --font-body/--font-mono actually resolve to, since
  // neither defines a SOFT or WONK axis.

  it("pins the Fraunces display face to SOFT 20 / WONK 1 (§13.1)", () => {
    const rootBlock = tokensCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootBlock).toMatch(/font-variation-settings:\s*"SOFT"\s*20,\s*"WONK"\s*1/);
  });

  it("keeps the tabular-nums utility for figures read in columns (§13.1)", () => {
    expect(tokensCss).toMatch(/\.tabular\s*\{\s*font-variant-numeric:\s*tabular-nums;?\s*\}/);
  });
});
