import { describe, expect, it, vi } from "vitest";

/**
 * PRD §13.1 names three faces - Fraunces (display, `SOFT 20 / WONK 1`), IBM
 * Plex Sans (body) and IBM Plex Mono (ledger rows/protocols/values) - and
 * nothing in the app loaded any of them before this: every screen fell back
 * to Georgia/system-ui, which is not the identity the PRD describes.
 *
 * `next/font/google` is mocked here on purpose: calling the real loader
 * hits the network for the actual font files, which is both slow and the
 * wrong thing to pin in a unit test - what this suite pins is the
 * *configuration* `apps/web/app/fonts.ts` passes to it (subsets, weights,
 * axes, the `--font-*` variable names `tokens.css` already declares, and
 * `display: "swap"` for RNF-03's LCP budget). The real, unmocked download
 * and self-hosting is exercised by `next build`, which this task requires
 * to run anyway.
 */
const fontCalls: Record<string, unknown> = {};

vi.mock("next/font/google", () => ({
  Fraunces: vi.fn((opts: unknown) => {
    fontCalls.Fraunces = opts;
    return { className: "fraunces-class", variable: "fraunces-variable", style: { fontFamily: "mock-fraunces" } };
  }),
  IBM_Plex_Sans: vi.fn((opts: unknown) => {
    fontCalls.IBM_Plex_Sans = opts;
    return { className: "sans-class", variable: "sans-variable", style: { fontFamily: "mock-sans" } };
  }),
  IBM_Plex_Mono: vi.fn((opts: unknown) => {
    fontCalls.IBM_Plex_Mono = opts;
    return { className: "mono-class", variable: "mono-variable", style: { fontFamily: "mock-mono" } };
  }),
}));

const fonts = await import("../app/fonts.js");

describe("app fonts (PRD §13.1)", () => {
  it("loads Fraunces for --font-display with its SOFT/WONK identity available and a pt-BR-sufficient subset", () => {
    expect(fontCalls.Fraunces).toMatchObject({ subsets: ["latin"], variable: "--font-display" });
    // Google's "latin" subset already spans U+0000-00FF (every accented
    // letter Brazilian Portuguese uses - ã, õ, ç, é...), so "latin-ext" and
    // every other subset Fraunces ships would be bytes RNF-05's budget has
    // no reason to spend.
    expect((fontCalls.Fraunces as { subsets: string[] }).subsets).not.toContain("latin-ext");
    expect((fontCalls.Fraunces as { axes: string[] }).axes.slice().sort()).toEqual(["SOFT", "WONK"]);
  });

  it("loads IBM Plex Sans for --font-body at only the weights the app's CSS actually sets", () => {
    expect(fontCalls.IBM_Plex_Sans).toMatchObject({ subsets: ["latin"], variable: "--font-body" });
    // laudo.module.css sets font-weight 400 (body text, the default) and
    // 600 (every heading/button) and nothing else - the full variable
    // 100..700 range next/font would otherwise fetch is bytes this page
    // never renders.
    expect((fontCalls.IBM_Plex_Sans as { weight: string[] }).weight.slice().sort()).toEqual(["400", "600"]);
  });

  it("loads IBM Plex Mono for --font-mono at the one weight every ledger row/badge/label uses", () => {
    expect(fontCalls.IBM_Plex_Mono).toMatchObject({
      subsets: ["latin"],
      variable: "--font-mono",
      weight: ["400"],
    });
  });

  it("never blocks first paint on the font download, for RNF-03's 2,0s LCP budget", () => {
    expect(fontCalls.Fraunces).toMatchObject({ display: "swap" });
    expect(fontCalls.IBM_Plex_Sans).toMatchObject({ display: "swap" });
    expect(fontCalls.IBM_Plex_Mono).toMatchObject({ display: "swap" });
  });

  it("exposes a variable className for all three faces, ready to apply to <html>", () => {
    expect(fonts.fraunces.variable).toBe("fraunces-variable");
    expect(fonts.ibmPlexSans.variable).toBe("sans-variable");
    expect(fonts.ibmPlexMono.variable).toBe("mono-variable");
  });
});
