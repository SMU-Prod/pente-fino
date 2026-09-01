import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * `app/fonts.ts` is mocked here for the same reason `test/fonts.test.ts`
 * mocks `next/font/google` directly: what this test pins is that
 * `RootLayout` actually applies all three fonts' `.variable` className to
 * `<html>` - that is the one step that makes `tokens.css`'s
 * `--font-display`/`--font-body`/`--font-mono` resolve to the real,
 * self-hosted faces instead of silently keeping the Georgia/system-ui
 * fallback forever, no matter how correctly `fonts.ts` itself is
 * configured.
 */
vi.mock("../app/fonts.js", () => ({
  fraunces: { variable: "mock-fraunces-variable" },
  ibmPlexSans: { variable: "mock-sans-variable" },
  ibmPlexMono: { variable: "mock-mono-variable" },
}));

const { default: RootLayout } = await import("../app/layout.js");

describe("RootLayout (PRD §13.1)", () => {
  it("applies all three font CSS-variable classes to <html>, so tokens.css's --font-* vars resolve to the loaded faces", () => {
    const html = renderToStaticMarkup(RootLayout({ children: "child" as unknown as ReactNode }));
    expect(html).toContain("mock-fraunces-variable");
    expect(html).toContain("mock-sans-variable");
    expect(html).toContain("mock-mono-variable");
  });
});
