import { and, desc, eq } from "drizzle-orm";
import { newId, type EventType } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import { anonymousSessions, cases, events, findings, invoices, issuers } from "./schema.js";

export type Session = { userId: string } | { sessionId: string };

type Db = ReturnType<typeof getUnscopedDb>;

/**
 * Creates the `anonymous_sessions` row a fresh session id needs before any
 * invoice can reference it: `invoices.session_id` carries a real foreign key
 * to `anonymous_sessions.id`, so inserting an invoice for a session id that
 * has no matching row fails at the database level. A caller that mints a new
 * session id (the web app's upload-sign route, at this writing) must call
 * this before the first `insertInvoice` for that session.
 *
 * `onConflictDoNothing` on the primary key makes this idempotent: a second
 * call for a session id that already exists is a silent no-op, not an error
 * and not a refreshed `expiresAt`. The expiry duration is a product policy
 * (RF-140's 30 days), not a persistence concern, so it is a required
 * parameter rather than a constant hard-coded in this package.
 */
export async function ensureAnonymousSession(sessionId: string, expiresAt: Date, db: Db = getUnscopedDb()) {
  await db.insert(anonymousSessions)
    .values({ id: sessionId, expiresAt })
    .onConflictDoNothing({ target: anonymousSessions.id });
}

type NewInvoice = {
  contentHash: string;
  source: "pdf_text" | "pdf_vision" | "photo" | "csv" | "email";
  issuerId?: string;
  fileKey?: string;
};

/**
 * The single door to user data (INV-008). Every read and write here carries
 * the ownership filter, and the eslint rule `require-with-user` stops any
 * other module outside `packages/db` from reaching around it: it forbids
 * importing `getUnscopedDb` or `schema` from `@pentefino/db`, and it forbids
 * reaching a raw driver module (`postgres`, `drizzle-orm/postgres-js`,
 * `drizzle-orm/pglite`, `@electric-sql/pglite`, or any subpath of one) via
 * static import, dynamic `import()`, `require()`, or re-export. A
 * legitimate unscoped caller — a background job with no user session, say —
 * can still get past the gate, but only visibly: it carries an explicit
 * `// eslint-disable-next-line pentefino/require-with-user` with a reason on
 * the same line, so the exception shows up in review and in grep instead of
 * hiding in a rule allowlist.
 *
 * Each predicate below is built against the table it filters, not reused
 * across tables: `invoices` and `events` each carry their own `userId` /
 * `sessionId` columns, and `cases.userId` is NOT NULL (a case cannot be
 * created before a session claims an account), so an anonymous session can
 * never own one.
 */
export function withUser(session: Session, db: Db = getUnscopedDb()) {
  const userId = "userId" in session ? session.userId : null;
  const sessionId = "sessionId" in session ? session.sessionId : null;
  if (!userId && !sessionId) throw new Error("withUser requires a userId or a sessionId");

  const ownsInvoice = userId ? eq(invoices.userId, userId) : eq(invoices.sessionId, sessionId!);
  const ownsEvent = userId ? eq(events.userId, userId) : eq(events.sessionId, sessionId!);

  return {
    async invoices() {
      return db.select().from(invoices).where(ownsInvoice).orderBy(desc(invoices.createdAt));
    },

    async cases() {
      if (!userId) return [];
      return db.select().from(cases).where(eq(cases.userId, userId)).orderBy(desc(cases.createdAt));
    },

    async insertInvoice(values: NewInvoice) {
      const id = newId("inv");
      await db.insert(invoices).values({
        id, ...values,
        ...(userId ? { userId } : { sessionId }),
        status: "queued",
      });
      return id;
    },

    async findingsForInvoice(invoiceId: string) {
      const [owned] = await db.select({ id: invoices.id }).from(invoices)
        .where(and(eq(invoices.id, invoiceId), ownsInvoice));
      if (!owned) return [];
      return db.select().from(findings).where(eq(findings.invoiceId, invoiceId));
    },

    /**
     * Same ownership gate as `findingsForInvoice`: a caller can only ever
     * learn the issuer of an invoice it owns. Returns `null` both when the
     * invoice is not (yet) owned by this session/user and when it is owned
     * but has no issuer assigned yet (`invoices.issuerId` is nullable -
     * issuer detection, RF-105/RF-106, is not implemented at E0) - the PRD
     * §8.2 report shape declares `issuer` as always present, so this never
     * omits the key, only its value.
     */
    async issuerForInvoice(invoiceId: string) {
      const [owned] = await db.select({ issuerId: invoices.issuerId }).from(invoices)
        .where(and(eq(invoices.id, invoiceId), ownsInvoice));
      if (!owned?.issuerId) return null;
      const [issuer] = await db.select().from(issuers).where(eq(issuers.id, owned.issuerId));
      return issuer ?? null;
    },

    async recordEvent(type: EventType, payload: Record<string, unknown> = {}) {
      await db.insert(events).values({
        id: newId("evt"), type, payload,
        ...(userId ? { userId } : { sessionId }),
      });
    },

    async events() {
      return db.select().from(events).where(ownsEvent).orderBy(desc(events.occurredAt));
    },
  };
}

export type ScopedDb = ReturnType<typeof withUser>;
