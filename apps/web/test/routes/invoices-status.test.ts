import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { newId, type InvoiceCanonical } from "@pentefino/core";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { signSession } from "../../lib/session.js";
import { createCookieStore, jarFor, type MockCookieStore } from "../helpers/cookies.js";
import { buildTestContainer } from "../helpers/container.js";
import type { ProgressMessage } from "../../lib/status-stream.js";

const { anonymousSessions, events, invoices, issuers } = schema;

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { cookies } = await import("next/headers");
const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/invoices/[id]/status/route.js");
const { ingestIdempotencyKey } = await import("../../lib/ingest-key.js");

/** A promise plus its resolve/reject, matching invoices-process.test.ts's own helper. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Joins the same background run the route's own `queue.enqueue` call
 * started, through the queue's own idempotency-key dedup - exactly the
 * pattern invoices-process.test.ts already established for this queue.
 */
async function drainIngest(invoiceId: string) {
  const { queue } = container();
  await queue.enqueue("ingest", { invoiceId }, { idempotencyKey: ingestIdempotencyKey(invoiceId) }).catch(() => {});
}

/**
 * Reads a `text/event-stream` body incrementally, decoding each `data: ...`
 * line into a `ProgressMessage`. Buffers partial chunks across reads (SSE
 * messages are `\n\n`-delimited and are not guaranteed to land in a single
 * chunk) and exposes both "give me the next message, waiting on the real
 * stream for it" and "drain everything until the stream closes" - the two
 * primitives the tests below need to prove streaming (not replay-then-close)
 * without guessing at timing.
 */
function messageReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: ProgressMessage[] = [];
  let closed = false;

  function drainBuffer() {
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith("data:")) pending.push(JSON.parse(line.slice("data:".length).trim()));
    }
  }

  async function pull() {
    const { value, done } = await reader.read();
    if (done) {
      closed = true;
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    drainBuffer();
  }

  return {
    /** Waits on the real stream for the next message, or `null` once it closes with nothing left. */
    async next(): Promise<ProgressMessage | null> {
      while (pending.length === 0 && !closed) await pull();
      return pending.length > 0 ? (pending.shift() ?? null) : null;
    },
    /** Reads until the stream closes, returning every message seen (including any already buffered). */
    async rest(): Promise<ProgressMessage[]> {
      while (!closed) await pull();
      const all = [...pending];
      pending.length = 0;
      return all;
    },
    get isClosed() {
      return closed;
    },
    cancel(reason?: unknown) {
      return reader.cancel(reason);
    },
  };
}

const SECRET = "route-test-secret";

const canonical = {
  issuer: { name: "Claro Móvel", cnpj: "40432544000147", category: "telecom" },
  period: { start: "2026-07-01", end: "2026-07-31" },
  dueDate: "2026-08-10",
  totalCents: 9000,
  sections: [{ name: "Serviços", items: [{ description: "Plano pós-pago", amountCents: 9000 }] }],
  extraction: { confidence: 0.95, warnings: [] },
} as InvoiceCanonical;

// Same shape as `canonical`, but its `totalCents` is wildly off from the
// items' sum - RF-108's `total_mismatch` check (packages/core/src/invoice
// /validate.ts) rejects it, routing the invoice to `needs_review` instead of
// `analyzed`, deterministically, with no need for a special fixture PDF.
const mismatchedCanonical = { ...canonical, totalCents: 1 } as InvoiceCanonical;

let ctx: TestDb;
let storageRoot: string;
let mailRoot: string;
const fileKey = "uploads/status.pdf";
const sessionA = "ses_owner00000000000000";
const sessionB = "ses_other00000000000000";
let invoiceId: string;

const SCAN_PDF = new Uint8Array(readFileSync(
  fileURLToPath(new URL("../../../../fixtures/synthetic/pdfs/scan-1page.pdf", import.meta.url)),
));

function seedStorageObject(key: string) {
  const target = join(storageRoot, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, SCAN_PDF);
}

beforeEach(async () => {
  process.env.SESSION_SIGNING_SECRET = SECRET;
  ctx = await createTestDb();
  storageRoot = mkdtempSync(join(tmpdir(), "pf-web-storage-"));
  mailRoot = mkdtempSync(join(tmpdir(), "pf-web-mail-"));
  vi.mocked(container).mockReturnValue(
    buildTestContainer({ db: ctx.db, storageRoot, mailRoot, fixtures: { [fileKey]: canonical } }),
  );

  seedStorageObject(fileKey);
  await ctx.db.insert(anonymousSessions).values([
    { id: sessionA, expiresAt: new Date(Date.now() + 60_000) },
    { id: sessionB, expiresAt: new Date(Date.now() + 60_000) },
  ]);
  const issuerId = newId("iss");
  await ctx.db.insert(issuers).values({ id: issuerId, slug: issuerId, category: "telecom", displayName: "Claro" });
  invoiceId = newId("inv");
  await ctx.db.insert(invoices).values({
    id: invoiceId, issuerId, sessionId: sessionA, contentHash: "status-hash", source: "pdf_text",
    status: "queued", fileKey,
  });
  // `POST /uploads/sign` (not exercised by this route test) is what records
  // this in production, right when the invoice row is created - inserted
  // directly here so the trail this route reads from starts the same way a
  // real one does.
  await ctx.db.insert(events).values({ id: newId("evt"), type: "invoice_uploaded", sessionId: sessionA, invoiceId });
});

afterEach(async () => {
  await ctx.close();
  rmSync(storageRoot, { recursive: true, force: true });
  rmSync(mailRoot, { recursive: true, force: true });
  delete process.env.SESSION_SIGNING_SECRET;
  vi.restoreAllMocks();
});

function useCookies(store: MockCookieStore) {
  vi.mocked(cookies).mockImplementation(async () => jarFor(store) as never);
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(id = invoiceId, init: RequestInit = {}): Request {
  return new Request(`http://localhost/api/invoices/${id}/status`, init);
}

/** Fires ingestion the same way `POST /process` does - fire-and-forget, not awaited. */
function fireIngest(id = invoiceId) {
  const { queue } = container();
  queue.enqueue("ingest", { invoiceId: id }, { idempotencyKey: ingestIdempotencyKey(id) }).catch(() => {});
}

describe("GET /api/invoices/[id]/status", () => {
  it("returns forbidden with no session cookie at all", async () => {
    useCookies(createCookieStore());
    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
  });

  // --- INV-008: a stream is bound to a session exactly as a request is.

  it("returns not_found, not the other session's invoice, when a different session's cookie is presented (INV-008)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns the same not_found for someone else's invoice as for one that does not exist, so existence is never leaked", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionB, SECRET) }));
    const otherResponse = await GET(request(), ctxFor(invoiceId));
    const missingId = newId("inv");
    const missingResponse = await GET(request(missingId), ctxFor(missingId));
    expect(await otherResponse.json()).toEqual(await missingResponse.json());
  });

  // --- RF-141's acceptance itself: at least four distinct events between
  // `queued` and `analyzed`. Ingestion is left to actually run (no mocked
  // pipeline), so this exercises the real event trail the ingest task
  // writes, not a synthetic stand-in for it.

  // Drives a real ingestion and reads a real polling stream end to end, so it
  // is bounded by the pipeline rather than by assertion cost. Same reasoning
  // as the card's visual test: the default budget measures machine load, not
  // correctness.
  it("streams at least four distinct events between queued and analyzed for a client connected from the start", { timeout: 60_000 }, async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    fireIngest();

    const response = await GET(request(), ctxFor(invoiceId));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = messageReader(response.body!);
    const messages = await reader.rest();

    const distinct = new Set(messages.map((m) => JSON.stringify(m)));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
    expect(messages[0]).toEqual({ status: "queued", step: "classifying", progressPct: 0 });
    expect(messages.at(-1)).toEqual({ status: "analyzed", step: "done", progressPct: 100 });
    expect(reader.isClosed).toBe(true);

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("analyzed");
  });

  // --- The behaviour a stream makes possible that a plain request cannot:
  // genuinely interleaved delivery, not a wait-then-dump. The AI call is
  // gated shut, so if the very first message already showed `analyzed`,
  // that would prove the stream secretly waited for completion instead of
  // reporting the state that already exists.

  it("delivers an early message while ingestion is still gated open, before the pipeline could possibly have finished", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const gate = deferred<void>();
    const reachedGate = deferred<void>();
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: {
          async extractInvoice() {
            reachedGate.resolve();
            await gate.promise;
            return {
              canonical,
              usage: { provider: "fixture", model: "fixture", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
            };
          },
        },
      }),
    );

    fireIngest();
    await reachedGate.promise; // deterministic: waits for the real prerequisite, not a duration

    const response = await GET(request(), ctxFor(invoiceId));
    const reader = messageReader(response.body!);

    const first = await reader.next();
    expect(first).toEqual({ status: "queued", step: "classifying", progressPct: 0 });
    const second = await reader.next();
    expect(second).toEqual({ status: "extracting", step: "extracting", progressPct: 25 });

    // The gate is still shut - ingestion genuinely cannot have reached
    // `analyzed` yet, so the stream must not have closed.
    expect(reader.isClosed).toBe(false);
    const [midFlight] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(midFlight?.status).not.toBe("analyzed");

    gate.resolve();
    await drainIngest(invoiceId);
    const rest = await reader.rest();

    expect(rest.at(-1)).toEqual({ status: "analyzed", step: "done", progressPct: 100 });
    const all = [first, second, ...rest] as ProgressMessage[];
    expect(new Set(all.map((m) => JSON.stringify(m))).size).toBeGreaterThanOrEqual(4);
  });

  // --- A client that connects after the pipeline already finished must
  // learn the outcome rather than hang waiting for events that will never
  // come again.

  it("replays the full trail and closes immediately for a client that connects after the pipeline already finished", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    fireIngest();
    await drainIngest(invoiceId);
    const [settled] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(settled?.status).toBe("analyzed");

    const response = await GET(request(), ctxFor(invoiceId));
    const reader = messageReader(response.body!);
    const messages = await reader.rest();

    expect(reader.isClosed).toBe(true);
    expect(messages.at(-1)).toEqual({ status: "analyzed", step: "done", progressPct: 100 });
    expect(new Set(messages.map((m) => JSON.stringify(m))).size).toBeGreaterThanOrEqual(4);
  });

  // --- An invoice that reaches `failed` instead of `analyzed`: the stream
  // must end, saying which.

  it("ends the stream at failed, saying which, when ingestion genuinely fails mid-flight", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const gate = deferred<{ canonical: InvoiceCanonical; usage: Record<string, unknown> }>();
    const reachedGate = deferred<void>();
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: {
          async extractInvoice() {
            reachedGate.resolve();
            return gate.promise as never;
          },
        },
      }),
    );

    fireIngest();
    await reachedGate.promise;

    const response = await GET(request(), ctxFor(invoiceId));
    const reader = messageReader(response.body!);
    expect(await reader.next()).toEqual({ status: "queued", step: "classifying", progressPct: 0 });
    expect(await reader.next()).toEqual({ status: "extracting", step: "extracting", progressPct: 25 });
    expect(reader.isClosed).toBe(false);

    gate.reject(new Error("simulated provider outage"));
    await drainIngest(invoiceId);

    const rest = await reader.rest();
    expect(reader.isClosed).toBe(true);
    expect(rest.at(-1)).toEqual({ status: "failed", step: "failed", progressPct: 100 });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("failed");
  });

  // --- An invoice that reaches `needs_review` instead of `analyzed`: same
  // requirement, different outcome.

  it("ends the stream at needs_review, saying which, when validation rejects the extraction", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    vi.mocked(container).mockReturnValue(
      buildTestContainer({ db: ctx.db, storageRoot, mailRoot, fixtures: { [fileKey]: mismatchedCanonical } }),
    );

    fireIngest();
    await drainIngest(invoiceId);
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(row?.status).toBe("needs_review");

    const response = await GET(request(), ctxFor(invoiceId));
    const reader = messageReader(response.body!);
    const messages = await reader.rest();

    expect(reader.isClosed).toBe(true);
    expect(messages.at(-1)).toEqual({ status: "needs_review", step: "needs_review", progressPct: 100 });
  });

  // --- A client that disconnects mid-stream must not leak the connection
  // or leave a polling loop running on the server.

  it("stops polling once the client's connection aborts, instead of leaking the interval", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const gate = deferred<void>();
    const reachedGate = deferred<void>();
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: {
          async extractInvoice() {
            reachedGate.resolve();
            await gate.promise;
            return {
              canonical,
              usage: { provider: "fixture", model: "fixture", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
            };
          },
        },
      }),
    );

    fireIngest();
    await reachedGate.promise;

    const controller = new AbortController();
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const response = await GET(request(invoiceId, { signal: controller.signal }), ctxFor(invoiceId));
    const reader = messageReader(response.body!);
    expect(await reader.next()).toEqual({ status: "queued", step: "classifying", progressPct: 0 });

    controller.abort();
    // Give the abort listener's microtask a turn to run before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(clearIntervalSpy).toHaveBeenCalled();

    gate.resolve();
    await drainIngest(invoiceId);
  });

  it("does not error when a reader cancels the stream directly (the underlying platform's own disconnect path)", async () => {
    useCookies(createCookieStore({ pf_session: signSession(sessionA, SECRET) }));
    const gate = deferred<void>();
    const reachedGate = deferred<void>();
    vi.mocked(container).mockReturnValue(
      buildTestContainer({
        db: ctx.db, storageRoot, mailRoot,
        ai: {
          async extractInvoice() {
            reachedGate.resolve();
            await gate.promise;
            return {
              canonical,
              usage: { provider: "fixture", model: "fixture", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
            };
          },
        },
      }),
    );

    fireIngest();
    await reachedGate.promise;

    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const response = await GET(request(), ctxFor(invoiceId));
    const reader = messageReader(response.body!);
    expect(await reader.next()).toEqual({ status: "queued", step: "classifying", progressPct: 0 });

    await expect(reader.cancel()).resolves.toBeUndefined();
    expect(clearIntervalSpy).toHaveBeenCalled();

    gate.resolve();
    await drainIngest(invoiceId);
  });
});
