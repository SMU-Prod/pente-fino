import { and, desc, eq, inArray } from "drizzle-orm";
import { newId, newPublicToken, type ContestDocument, type EventType, type Stage } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import {
  anonymousSessions, caseDocuments, cases, events, findings, invoiceItems, invoices, issuers, rules,
} from "./schema.js";

export type Session = { userId: string } | { sessionId: string };

type Db = ReturnType<typeof getUnscopedDb>;

/**
 * RF-143: "isso eu contratei" must remove a finding from the report for
 * good, not just from the client's in-memory list until the next fetch -
 * `findingsForInvoice` is where both the list and its totals
 * (apps/web/lib/report.ts sums exactly what this returns) draw from, so
 * this is the one place that has to know which of `findings.status`'s six
 * values still describe money genuinely at stake:
 *
 *   - `open`               untouched - nobody has looked at it yet.
 *   - `confirmed_by_user`  the person said this charge is wrong - the
 *                          strongest signal the screen can carry.
 *   - `contested`          a case (E4) is actively disputing it - still
 *                          unresolved, so still shown.
 *   - `unresolved`         a dispute (E5) concluded without fixing the
 *                          charge - the money was never recovered, so this
 *                          is not "handled", it is exactly as live as
 *                          `open`, just with a failed attempt behind it.
 *
 * `dismissed_by_user` and `resolved` are the two statuses left out:
 * dismissal means the person recognises the charge (a false positive from
 * their side), and `resolved` means the case already fixed this specific
 * amount - in both cases there is nothing left on this invoice for the
 * report to ask the person to check. A finding whose case is resolved is
 * a different thing from one nobody has looked at, and showing it as if it
 * still needed attention would misrepresent what is actually still owed.
 */
const VISIBLE_FINDING_STATUSES = ["open", "confirmed_by_user", "contested", "unresolved"] as const;

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
 * Turns the raw session id a request's signed cookie carries into the
 * `Session` every method below actually scopes on (E4 Task 4). Every route
 * built before this one only ever needed `{ sessionId }`: `invoices` and
 * `events` each carry their own `session_id` column, so an anonymous
 * visitor reads and writes its own data without ever resolving to a
 * `userId`. `cases.userId` breaks that pattern - it is NOT NULL (see the
 * doc comment on `withUser` below), so a case, and everything that hangs off
 * one (`case_documents`, here), can only ever belong to a real `users` row,
 * never to a bare anonymous session.
 *
 * `anonymous_sessions.claimed_by_user_id` (set once, by `claim.ts`'s
 * `migrate`, the moment RF-147's e-mail code is confirmed) is the only place
 * that link lives - a cookie that still carries the original `sessionId`
 * does not by itself say who, if anyone, that session now resolves to. A
 * session id this database has never seen (no `anonymous_sessions` row at
 * all - should not happen for a cookie this app itself signed, but nothing
 * here assumes it cannot) degrades to the same `{ sessionId }` an unclaimed
 * session gets, rather than throwing: whatever it resolves to still owns no
 * case, and every case-scoped method below already returns nothing (never
 * an error) for that.
 */
export async function resolveSession(sessionId: string, db: Db = getUnscopedDb()): Promise<Session> {
  const [row] = await db.select({ claimedByUserId: anonymousSessions.claimedByUserId })
    .from(anonymousSessions)
    .where(eq(anonymousSessions.id, sessionId));
  if (row?.claimedByUserId) return { userId: row.claimedByUserId };
  return { sessionId };
}

type NewCaseDocument = {
  caseId: string;
  stage: Stage;
  kind: "sac_script" | "contest_letter" | "gov_text" | "regulator_text" | "dossier";
  promptVersion: number;
  variant?: string;
  body: ContestDocument;
};

/**
 * The single door to user data (INV-008). Every read and write here carries
 * the ownership filter, and the eslint rule `require-with-user` stops any
 * other module outside `packages/db` from reaching around it, in four ways:
 *
 *   - Only a fixed allowlist of names may be imported from this package's
 *     entry point, `@pentefino/db`: `withUser`, `ensureAnonymousSession`,
 *     and the `Database`/`Session`/`ScopedDb` types. Every other name —
 *     `getUnscopedDb`, the `schema` namespace, and every individual table
 *     `schema` holds (`invoices`, `events`, ...) — is rejected, whether
 *     imported directly or re-exported.
 *   - A namespace import of that same entry point (`import * as ns from
 *     "@pentefino/db"`) is rejected outright, since one such binding would
 *     reach every name above at once.
 *   - Reaching a raw driver module — `postgres`, `drizzle-orm/postgres-js`,
 *     `drizzle-orm/pglite`, `@electric-sql/pglite`, or any subpath of one —
 *     is forbidden via static import, dynamic `import()`, `require()`, or
 *     re-export.
 *   - Importing any subpath of `@pentefino/db` itself (`@pentefino/db/testing`,
 *     which hands back a live, unscoped PGlite database) is forbidden from
 *     anywhere other than a real test file.
 *
 * A legitimate unscoped caller — a background job with no user session, say —
 * can still get past the first three checks, but only visibly: it carries an
 * explicit `// eslint-disable-next-line pentefino/require-with-user` with a
 * reason on the same line (see `apps/jobs/src/tasks/ingest.ts`), so the
 * exception shows up in review and in grep instead of hiding in a rule
 * allowlist.
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

    /**
     * RF-164/INV-008, the read half. A `case_documents` row is reached only
     * by proving the case that owns it belongs to this caller - the same
     * join-through pattern `setFindingFeedback` below uses for `invoices`,
     * except joined through `cases` instead. `cases.userId` is NOT NULL (see
     * `withUser`'s own doc comment above), so an anonymous session -
     * `userId` is `null` here - can never own a case and therefore never a
     * document either; short-circuiting on that avoids a query that could
     * only ever come back empty.
     *
     * Both `body` (the generated version) and `editedBody` (set only once
     * `editCaseDocument` below has run) come back on the same row - RF-164's
     * "as duas versões consultáveis" is this: nothing here ever drops the
     * generated version just because an edit exists.
     */
    async caseDocument(docId: string) {
      if (!userId) return null;
      const [row] = await db.select({
        id: caseDocuments.id,
        caseId: caseDocuments.caseId,
        stage: caseDocuments.stage,
        kind: caseDocuments.kind,
        promptVersion: caseDocuments.promptVersion,
        variant: caseDocuments.variant,
        body: caseDocuments.body,
        userEdited: caseDocuments.userEdited,
        editedBody: caseDocuments.editedBody,
        sentAt: caseDocuments.sentAt,
        createdAt: caseDocuments.createdAt,
        updatedAt: caseDocuments.updatedAt,
      })
        .from(caseDocuments)
        .innerJoin(cases, eq(caseDocuments.caseId, cases.id))
        .where(and(eq(caseDocuments.id, docId), eq(cases.userId, userId)));
      return row ?? null;
    },

    /**
     * Persists a freshly assembled/generated document - Task 1's
     * `assembleContest` output, turned into prose by Task 2's generator -
     * against a case this caller owns. `userEdited` starts `false` and
     * `editedBody` `null` by construction (the schema's own defaults): a
     * document that has never been edited has only ever had one version, and
     * that is exactly what `userEdited: false` records.
     *
     * Ownership is checked the same way every other write in this file is:
     * `input.caseId` must resolve to a case whose `userId` matches this
     * caller's, or nothing is written and `null` comes back. Unlike
     * `insertInvoice`'s forged-owner guard, there is no separate owner
     * column on `case_documents` itself to spread over a caller-supplied
     * value - ownership here is entirely transitive through `caseId`, which
     * this check already verifies before the insert ever runs.
     */
    async createCaseDocument(input: NewCaseDocument) {
      if (!userId) return null;
      const [owned] = await db.select({ id: cases.id }).from(cases)
        .where(and(eq(cases.id, input.caseId), eq(cases.userId, userId)));
      if (!owned) return null;
      const id = newId("doc");
      await db.insert(caseDocuments).values({ id, ...input });
      return id;
    },

    /**
     * RF-164: the only write path for a person's edit. `userEdited` flips to
     * `true` and `editedBody` receives what they wrote, but `body` - the
     * version the generator actually produced - is never touched by this
     * method at all. That is `INV-003` at the data layer, not just in the
     * text (see this file's header and the E4 design doc): the reason
     * `user_edited` exists is so the record can always say whose words a
     * document carries, generated or the person's own, and overwriting
     * `body` here would erase exactly the distinction the column exists to
     * preserve.
     *
     * Takes both `caseId` and `docId` - not just `docId`, unlike
     * `caseDocument` above - because this is the write path behind
     * `POST /api/cases/:id/documents/:docId/edit` (PRD §8.2): the route
     * hands over both halves of its own URL, and checking that the document
     * actually belongs to *that* case (not just to this user, who may own
     * several) closes off a caller that gets the two ids right for itself
     * individually but wrong as a pair. Ownership is checked the same way
     * `setFindingFeedback` checks it for a finding - joined through the
     * owning row - folding "not owned", "wrong case for this doc", and "does
     * not exist" into the same `null`, so the caller (and therefore the HTTP
     * response) can never learn which one it was (INV-008).
     */
    async editCaseDocument(caseId: string, docId: string, editedBody: ContestDocument) {
      if (!userId) return null;
      const [owned] = await db.select({ id: caseDocuments.id }).from(caseDocuments)
        .innerJoin(cases, eq(caseDocuments.caseId, cases.id))
        .where(and(
          eq(caseDocuments.id, docId),
          eq(caseDocuments.caseId, caseId),
          eq(cases.userId, userId),
        ));
      if (!owned) return null;
      await db.update(caseDocuments)
        .set({ userEdited: true, editedBody, updatedAt: new Date() })
        .where(eq(caseDocuments.id, docId));
      const [row] = await db.select().from(caseDocuments).where(eq(caseDocuments.id, docId));
      return row!;
    },

    async insertInvoice(values: NewInvoice) {
      const id = newId("inv");
      await db.insert(invoices).values({
        id, ...values,
        ...(userId ? { userId } : { sessionId }),
        status: "queued",
        // RF-145/RF-146: minted alongside the id itself, not lazily on first
        // share - see the doc comment on `invoices.publicToken` in
        // schema.ts for why this is a separate value from `id`.
        publicToken: newPublicToken(),
      });
      return id;
    },

    /**
     * RF-125: a `shadow` finding is how a rule still on probation collects
     * data without ever reaching a user - `eq(findings.shadow, false)`
     * below is the one place that filter lives, so every caller (today just
     * the `/report` route, which also sums this same result for its totals)
     * gets it for free instead of having to remember it itself.
     *
     * RF-143: `inArray(findings.status, VISIBLE_FINDING_STATUSES)` is the
     * other half of that same guarantee - see the constant's own comment
     * for which of the six `findings.status` values still belong on a
     * report and why. This has to live here, not in a caller, for the exact
     * reason the shadow filter does: a status once excluded here can never
     * come back on a reload, no matter which of `findingsForInvoice`'s
     * callers renders next.
     *
     * `rules` and `invoiceItems` are joined in even though neither is a
     * user-scoped table of its own (no separate ownership check needed for
     * either): `ruleSpec` is what lets a caller recognise a `confirm`-kind
     * rule and surface its question as `askUser` (RF-124) without a second
     * round trip, and `section` is what RF-128's same-section clustering
     * groups findings by. `ruleId` is NOT NULL on `findings` and always
     * references a real row, so the inner join never drops a genuine
     * finding; `itemId` is nullable (a whole-invoice, e.g. arithmetic,
     * finding has none), hence the left join for it.
     */
    async findingsForInvoice(invoiceId: string) {
      const [owned] = await db.select({ id: invoices.id }).from(invoices)
        .where(and(eq(invoices.id, invoiceId), ownsInvoice));
      if (!owned) return [];
      return db.select({
        id: findings.id,
        invoiceId: findings.invoiceId,
        itemId: findings.itemId,
        ruleId: findings.ruleId,
        ruleVersion: findings.ruleVersion,
        confidence: findings.confidence,
        evidence: findings.evidence,
        amountCents: findings.amountCents,
        doubledCents: findings.doubledCents,
        shadow: findings.shadow,
        status: findings.status,
        createdAt: findings.createdAt,
        updatedAt: findings.updatedAt,
        ruleSpec: rules.spec,
        section: invoiceItems.section,
      })
        .from(findings)
        .innerJoin(rules, eq(findings.ruleId, rules.id))
        .leftJoin(invoiceItems, eq(findings.itemId, invoiceItems.id))
        .where(and(
          eq(findings.invoiceId, invoiceId),
          eq(findings.shadow, false),
          inArray(findings.status, [...VISIBLE_FINDING_STATUSES]),
        ))
        .orderBy(findings.createdAt);
    },

    /**
     * The only write path to the `dismissed`/`confirmed` signal RF-126 and
     * RF-127's automatic promotion/pause read (see
     * apps/web/app/api/findings/[id]/feedback/route.ts) - ownership is
     * enforced the same way every other method here does it, by joining
     * through `invoices` with the same `ownsInvoice` predicate. A finding
     * whose invoice this session/user does not own is indistinguishable
     * from one that does not exist at all: both return `null`, so the
     * caller (and therefore the HTTP response) can never learn which case
     * it was (INV-008).
     *
     * Returns the rule that produced the finding along with the invoice,
     * because the caller has to put `ruleSlug` and `ruleVersion` into the
     * event it records. `rule-metrics.ts` attributes a dismissal to a rule
     * by exactly those two fields and SKIPS any event missing either — so
     * an event without them is not a smaller signal, it is no signal. That
     * matters more than it looks: with `dismissed` stuck at zero, RF-126's
     * promotion test (`dismissed / fired < 0,15`) is satisfied by every
     * rule forever, and the shadow period stops being a filter and becomes
     * a 30-firing delay before anything at all goes live.
     */
    async setFindingFeedback(findingId: string, status: "confirmed_by_user" | "dismissed_by_user") {
      const [owned] = await db.select({
        id: findings.id,
        invoiceId: findings.invoiceId,
        ruleSlug: rules.slug,
        ruleVersion: findings.ruleVersion,
      })
        .from(findings)
        .innerJoin(invoices, eq(findings.invoiceId, invoices.id))
        .innerJoin(rules, eq(findings.ruleId, rules.id))
        .where(and(eq(findings.id, findingId), ownsInvoice));
      if (!owned) return null;
      await db.update(findings).set({ status }).where(eq(findings.id, findingId));
      return owned;
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

    /**
     * `invoiceId` is optional because a handful of event types (a
     * `session_claimed`, say) are not about any one invoice at all, so there
     * is nothing to stamp. Whenever a caller does have an invoice id at
     * hand, it must pass it: A3 says the event trail is what metrics, the
     * adaptive engine and auditing all read, and `events.invoiceId` is the
     * column that lets a consumer correlate the trail to one specific
     * invoice instead of an entire session - a session can hold more than
     * one invoice, and a session-scoped read alone cannot tell their events
     * apart.
     *
     * `caseId` is the same idea, added for E4 Task 4's `contest_edited` (and
     * whatever `contest_generated`/`case_created`/... comes to record
     * itself against a case rather than an invoice): `events.caseId` already
     * carries its own index (`events_case_time`) for exactly this, and a
     * case-scoped event with no `caseId` stamped would be unreachable from a
     * future case timeline the same way an invoice-scoped one without
     * `invoiceId` would be.
     */
    async recordEvent(
      type: EventType,
      payload: Record<string, unknown> = {},
      invoiceId?: string,
      caseId?: string,
    ) {
      await db.insert(events).values({
        id: newId("evt"), type, payload,
        ...(userId ? { userId } : { sessionId }),
        ...(invoiceId ? { invoiceId } : {}),
        ...(caseId ? { caseId } : {}),
      });
    },

    async events() {
      return db.select().from(events).where(ownsEvent).orderBy(desc(events.occurredAt));
    },

    /**
     * RF-141: the SSE progress stream (`GET /api/invoices/:id/status`) reads
     * a durable trail rather than a live-only channel, precisely so a client
     * that connects after the pipeline already finished can replay it
     * instead of hanging on events that already happened. Same ownership
     * gate as `findingsForInvoice`/`issuerForInvoice`: a wrong session and a
     * nonexistent invoice id both come back as an empty array (INV-008), and
     * the caller (already holding the result of its own `invoices()` check)
     * is the one that turns "empty" into `not_found` vs. "genuinely no
     * events yet".
     *
     * Ascending by `occurredAt` - the opposite of `events()` above, which
     * serves a most-recent-first activity feed. A progress stream replays
     * history in the order it happened, and a poller diffing "which of these
     * have I already sent" needs a stable order to walk.
     */
    async eventsForInvoice(invoiceId: string) {
      const [owned] = await db.select({ id: invoices.id }).from(invoices)
        .where(and(eq(invoices.id, invoiceId), ownsInvoice));
      if (!owned) return [];
      return db.select().from(events)
        .where(eq(events.invoiceId, invoiceId))
        .orderBy(events.occurredAt);
    },
  };
}

export type ScopedDb = ReturnType<typeof withUser>;
