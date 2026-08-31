import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { newId } from "@pentefino/core";
import type { Storage } from "@pentefino/core/ports";
import { createLocalStorage } from "@pentefino/adapters";
import { createTestDb, schema, type TestDb } from "@pentefino/db/testing";
import { createExpireFilesTask } from "../src/tasks/expire-files.js";

const { cases, events, invoices, issuers, users } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed reference instant, never the real wall clock (per the brief): every
// `createdAt`/`closedAt` below is computed relative to this, and it is the
// only value ever passed as `payload.now` to the task.
const NOW = new Date("2026-08-31T12:00:00.000Z");

let ctx: TestDb;
let root: string;
let issuerId: string;

function seedStorageObject(key: string, body = "fake pdf bytes") {
  const target = join(root, key);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function storage(): Storage {
  return createLocalStorage({ root, secret: "s" });
}

function task(customStorage?: Storage) {
  return createExpireFilesTask({ db: ctx.db, storage: customStorage ?? storage() });
}

async function insertInvoice(overrides: { createdAt?: Date } = {}): Promise<{ id: string; fileKey: string }> {
  const id = newId("inv");
  const fileKey = `uploads/${id}.pdf`;
  await ctx.db.insert(invoices).values({
    id, issuerId, contentHash: id, source: "pdf_text", status: "analyzed",
    createdAt: overrides.createdAt ?? NOW,
    fileKey,
  });
  return { id, fileKey };
}

beforeEach(async () => {
  ctx = await createTestDb();
  root = mkdtempSync(join(tmpdir(), "pf-expire-"));
  issuerId = newId("iss");
  await ctx.db.insert(issuers).values({
    id: issuerId, slug: "claro-movel", category: "telecom", displayName: "Claro Móvel",
  });
});

afterEach(async () => {
  await ctx.close();
  rmSync(root, { recursive: true, force: true });
});

describe("expire-files task (RF-110)", () => {
  it("deletes the file and clears fileKey for an invoice past its 30-day expiry", async () => {
    const { id, fileKey } = await insertInvoice({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    seedStorageObject(fileKey);

    await task()({ now: NOW.toISOString() });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row?.fileKey).toBeNull();
    expect(await storage().exists(fileKey)).toBe(false);

    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, id));
    expect(rows.map((r) => r.type)).toContain("invoice_file_expired");
  });

  it("leaves a file not yet expired untouched", async () => {
    const { id, fileKey } = await insertInvoice({ createdAt: new Date(NOW.getTime() - 10 * DAY_MS) });
    seedStorageObject(fileKey);

    await task()({ now: NOW.toISOString() });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row?.fileKey).toBe(fileKey);
    expect(await storage().exists(fileKey)).toBe(true);

    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, id));
    expect(rows).toHaveLength(0);
  });

  it("computes and stores fileExpiresAt for an invoice that has none yet, without touching its file", async () => {
    const createdAt = new Date(NOW.getTime() - 10 * DAY_MS);
    const { id, fileKey } = await insertInvoice({ createdAt });
    seedStorageObject(fileKey);

    await task()({ now: NOW.toISOString() });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row?.fileExpiresAt?.getTime()).toBe(createdAt.getTime() + 30 * DAY_MS);
  });

  it("expires an invoice whose case closed eight days ago, even though thirty days have not passed", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: `${userId}@example.com` });
    const { id, fileKey } = await insertInvoice({ createdAt: NOW });
    seedStorageObject(fileKey);
    await ctx.db.insert(cases).values({
      id: newId("cas"), userId, invoiceId: id, issuerId, findingIds: [],
      closedAt: new Date(NOW.getTime() - 8 * DAY_MS),
    });

    await task()({ now: NOW.toISOString() });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row?.fileKey).toBeNull();
    expect(await storage().exists(fileKey)).toBe(false);
  });

  it("does not expire an invoice whose case is still open, even past 30 days, when the case's own closedAt is null", async () => {
    const userId = newId("usr");
    await ctx.db.insert(users).values({ id: userId, email: `${userId}@example.com` });
    const { id, fileKey } = await insertInvoice({ createdAt: new Date(NOW.getTime() - 10 * DAY_MS) });
    seedStorageObject(fileKey);
    await ctx.db.insert(cases).values({
      id: newId("cas"), userId, invoiceId: id, issuerId, findingIds: [], closedAt: null,
    });

    await task()({ now: NOW.toISOString() });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row?.fileKey).toBe(fileKey);
  });

  it("is idempotent: a second run deletes nothing and errors on nothing", async () => {
    const { id, fileKey } = await insertInvoice({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    seedStorageObject(fileKey);

    const run = task();
    await run({ now: NOW.toISOString() });
    await expect(run({ now: NOW.toISOString() })).resolves.toBeUndefined();

    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, id));
    expect(rows.filter((r) => r.type === "invoice_file_expired")).toHaveLength(1);
  });

  it("marks a file already missing from storage as clean instead of retrying it forever", async () => {
    const { id } = await insertInvoice({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    // Deliberately never written to disk - simulates an object that is
    // already gone (or never actually landed) by the time the job runs.

    await task()({ now: NOW.toISOString() });

    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
    expect(row?.fileKey).toBeNull();
    const rows = await ctx.db.select().from(events).where(eq(events.invoiceId, id));
    expect(rows.map((r) => r.type)).toContain("invoice_file_expired");
  });

  it("does not abort the run when one invoice's storage delete fails, and records an event for it", async () => {
    const a = await insertInvoice({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    const b = await insertInvoice({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    seedStorageObject(a.fileKey);
    seedStorageObject(b.fileKey);

    const real = storage();
    const flaky: Storage = {
      ...real,
      async delete(fileKey: string) {
        if (fileKey === a.fileKey) throw new Error("simulated storage outage");
        return real.delete(fileKey);
      },
    };

    await task(flaky)({ now: NOW.toISOString() });

    const [rowA] = await ctx.db.select().from(invoices).where(eq(invoices.id, a.id));
    expect(rowA?.fileKey).toBe(a.fileKey); // untouched: eligible for retry on the next run

    const [rowB] = await ctx.db.select().from(invoices).where(eq(invoices.id, b.id));
    expect(rowB?.fileKey).toBeNull(); // b's own outcome is unaffected by a's failure

    const eventsA = await ctx.db.select().from(events).where(eq(events.invoiceId, a.id));
    expect(eventsA.map((r) => r.type)).toContain("invoice_file_expiry_failed");

    const eventsB = await ctx.db.select().from(events).where(eq(events.invoiceId, b.id));
    expect(eventsB.map((r) => r.type)).toContain("invoice_file_expired");
  });
});
