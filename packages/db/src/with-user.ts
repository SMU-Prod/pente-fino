import { and, desc, eq } from "drizzle-orm";
import { newId, type EventType } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import { cases, events, findings, invoices } from "./schema.js";

export type Session = { userId: string } | { sessionId: string };

type Db = ReturnType<typeof getUnscopedDb>;

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
