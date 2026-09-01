import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Canvas } from "@napi-rs/canvas";
import { newId, newPublicToken } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { TOKENS } from "@pentefino/ui";
import { buildTestContainer } from "../helpers/container.js";

const { anonymousSessions, findings, invoices, issuers, rules } = schema;

// Unlike card.test.ts, `next/og` is NOT mocked here: this file exercises
// RF-145's *other* required test, "a visual one" - the actual bytes a
// browser or a social-media scraper would receive, not the tree that
// produced them. `@napi-rs/canvas` (already a devDependency, used the same
// way in test/image-prepare.test.ts) does a real Skia decode of the PNG, so
// this proves the rendered raster - not just the inputs to the renderer -
// has the right shape.
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/card/[token]/route.js");

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const sessionA = "ses_owner00000000000000";

beforeEach(async () => {
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(buildTestContainer({ db: ctx.db, storageRoot, mailRoot }));
  await ctx.db.insert(anonymousSessions).values({ id: sessionA, expiresAt: new Date(Date.now() + 60_000) });
});

afterEach(async () => {
  await ctx.close();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function ctxFor(token: string) {
  return { params: Promise.resolve({ token }) };
}

function request(token: string): Request {
  return new Request(`http://localhost/api/card/${token}`);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe("GET /api/card/[token] — the rendered image (RF-145's visual test)", () => {
  it("produces a real 1200x630 PNG, painted with §13.1's paper token as its background", async () => {
    const issuerId = newId("iss");
    await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
    const invoiceId = newId("inv");
    const publicToken = newPublicToken();
    await ctx.db.insert(invoices).values({
      id: invoiceId, issuerId, sessionId: sessionA, contentHash: invoiceId,
      source: "pdf_text", status: "analyzed", publicToken,
    });
    const ruleId = newId("rul");
    await ctx.db.insert(rules).values({
      id: ruleId, slug: ruleId, category: "telecom", kind: "pattern",
      spec: { kind: "pattern", match: "x" }, confidenceBase: 0.5, author: "system", reason: "fixture",
    });
    await ctx.db.insert(findings).values({
      id: newId("fnd"), invoiceId, ruleId, ruleVersion: 1, confidence: 0.9, amountCents: 5160,
    });

    const response = await GET(request(publicToken), ctxFor(publicToken));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // real PNG signature

    const { loadImage } = await import("@napi-rs/canvas");
    const decoded = await loadImage(buffer);
    expect(decoded.width).toBe(1200);
    expect(decoded.height).toBe(630);

    // Sample a corner well clear of any text or the issuer badge - this
    // proves the actual raster (not just the element tree) was painted
    // with the real design token, not a hardcoded or default color.
    const canvas = new Canvas(decoded.width, decoded.height);
    const drawCtx = canvas.getContext("2d");
    drawCtx.drawImage(decoded, 0, 0);
    const [r, g, b] = drawCtx.getImageData(4, decoded.height - 4, 1, 1).data;
    const [er, eg, eb] = hexToRgb(TOKENS.light.paper);
    expect([r, g, b]).toEqual([er, eg, eb]);
  });

  it("returns a JSON 404, not an image, for an invalid token", async () => {
    const response = await GET(request("nope"), ctxFor("nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("image/png");
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
