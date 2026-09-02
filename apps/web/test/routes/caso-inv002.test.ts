import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `INV-002` on the case screen, stated as its acceptance states it: **no
 * data is sent to the channel by the system**. The person copies and
 * clicks; that is the whole product boundary (§1.5), and it is what keeps
 * this from being a service that needs someone else's credentials.
 *
 * The check reads the screen's own source rather than rendering it. A
 * render-based test can only prove that nothing left *during that render*,
 * which is the easy half — the failure being ruled out is a request fired
 * from a click, an effect, or a server action nobody exercised. Reading the
 * source catches the network call that exists but was never reached.
 *
 * Deliberately narrow: this covers `app/caso/[id]`, the screen that holds
 * the deep link and the copy button. It is not a repo-wide ban on `fetch` —
 * the upload page must fetch, and that is a different screen with a
 * different job.
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../app/caso/[id]/${relative}`, import.meta.url)), "utf8");
}

const SOURCES = ["page.tsx", "CopyText.tsx"];

// Anything that could put bytes on the wire from this screen.
const NETWORK_CALLS = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /new\s+WebSocket/,
  /new\s+EventSource/,
  /\baxios\b/,
  /<form\b/i,
  /"use server"/,
];

describe("INV-002: the case screen sends nothing to the channel", () => {
  it.each(SOURCES)("%s performs no network call of any kind", (file) => {
    const source = read(file);
    const found = NETWORK_CALLS.filter((pattern) => pattern.test(source)).map(String);
    expect(found).toEqual([]);
  });

  // The control. Without it the assertion above would still pass if `read`
  // silently returned an empty string, or if the file were renamed — the
  // exact way a gate stops gating without anyone noticing.
  it.each(SOURCES)("%s was actually read, so an empty match means something", (file) => {
    expect(read(file).length).toBeGreaterThan(200);
  });

  it("detects a network call when one is present, so the patterns are not decorative", () => {
    const planted = `${read("CopyText.tsx")}\nawait fetch("https://www.consumidor.gov.br/api");`;
    const found = NETWORK_CALLS.filter((pattern) => pattern.test(planted));
    expect(found.length).toBeGreaterThan(0);
  });

  // The deep link opens the channel in the person's own browser. `noopener`
  // is what stops the opened page from reaching back into this one through
  // `window.opener` — on a screen that has just put a contestation on the
  // clipboard, that is not a formality.
  it("opens the channel in a new tab with noopener, not through a request of ours", () => {
    const source = read("page.tsx");
    expect(source).toMatch(/rel="noreferrer noopener"/);
    expect(source).toMatch(/href=\{stagePlaybook\.deepLink\}/);
  });

  it("writes only to the clipboard", () => {
    expect(read("CopyText.tsx")).toMatch(/navigator\.clipboard\.writeText/);
  });
});
