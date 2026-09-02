import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { maskText, newId, newPublicToken, type CaseOutcome, type ContestDocument, type EventType, type Stage } from "@pentefino/core";
import { getUnscopedDb } from "./client.js";
import {
  anonymousSessions, caseDocuments, caseProtocols, cases, events, findings, invoiceItems, invoices, issuers, rules,
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
 * Which of `findings.status`'s six values may be put inside a *case* - the
 * claim actually made to a company (E5 Task 4). Deliberately NOT the same
 * list as `VISIBLE_FINDING_STATUSES` above, even though it starts from the
 * same idea of "money still at stake":
 *
 *   - `shadow` findings are excluded by a separate `eq(findings.shadow,
 *     false)` filter, not by this list, for RF-125's reason: a rule still on
 *     probation never reached the person at all, so its finding is not
 *     something they can be said to be disputing. A claim made to a company
 *     on behalf of someone who was never shown it is the one thing the
 *     shadow period exists to prevent.
 *   - `dismissed_by_user` and `resolved` are left out for exactly the reason
 *     `VISIBLE_FINDING_STATUSES` leaves them out - dismissal means the person
 *     recognises the charge, `resolved` means it was already put right; in
 *     neither case is there live money to contest.
 *   - `contested` is left out, and this is the one place the two lists
 *     genuinely diverge: a finding some *other* case is already disputing
 *     must never enter a second one. `recoveredCents` at close feeds §1.4's
 *     north-star metric ("R$ recuperados"), and the same charge sitting in
 *     two cases would be counted twice the moment both close. It also makes
 *     a double-submitted `POST /api/cases` fail on its second call instead of
 *     quietly opening a duplicate case over the same money.
 *   - `unresolved` stays in: a dispute that ended without fixing the charge
 *     leaves the money exactly as live as `open` did, just with a failed
 *     attempt behind it, so escalating again is the whole point of E5.
 *
 * **The obligation this list puts on every path that closes a case.**
 * Excluding `contested` here is only safe while something always moves a
 * finding *out* of `contested` when its case ends. `closeCase` below is the
 * only code in this repo that does, and it is a `withUser` method - a system
 * job with no user session cannot reach it. So a job that closes a case by
 * writing `cases` directly (E5 Task 3's day-60 abandonment sweep is the one
 * being built) and leaves `findings` alone strands those findings in
 * `contested` permanently: `VISIBLE_FINDING_STATUSES` keeps showing them on
 * the report as if a dispute were still running, and this list refuses to
 * let them into a new case, so the person can never contest that money
 * again. It is a dead end with no way out from the product, on exactly the
 * charges §1.4's north-star metric is counted from. Any path that closes a
 * case must settle its findings in the same transaction - `resolved` for a
 * `resolved` outcome, `unresolved` for the rest, which is what `closeCase`
 * does.
 */
const CONTESTABLE_FINDING_STATUSES = ["open", "confirmed_by_user", "unresolved"] as const;

/**
 * The one thing `createCase`'s transaction throws on purpose. It has to
 * throw rather than return, because returning from the callback commits -
 * and the whole point is that the case row, the flip to `contested` and the
 * `case_created` event unwind together when the concurrency gate fails.
 * `createCase` catches this exact class at its own boundary and returns
 * `null`, so a lost race looks to the caller like every other rejection
 * (INV-008) instead of a 500.
 *
 * It is a named class rather than a bare `Error` so the catch can be narrow:
 * a genuine database fault raised inside the same transaction - a dropped
 * connection, a constraint the schema still enforces - must keep propagating.
 * A `catch {}` around a transaction is how those stop being noticed.
 */
class CaseFindingRaceLost extends Error {}

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

    /**
     * Opens a case: the write nothing in this codebase had until E5 Task 4,
     * which is why the `case_created` event had never once been recorded.
     *
     * **Stage.** A new case starts at `draft` with no deadline, and
     * `nextStage` is deliberately not consulted. §9.1's only edge out of
     * `draft` is "usuário cria contestação", which is the contestation
     * *document* (E4's generator, and the advance route that follows it),
     * not the case row - `cases.stage` defaults to `draft` in §6.2's schema
     * for exactly that reason, and `StageEvent` has no member that could
     * even express "a case was just opened". §20.2's playbook has no `draft`
     * entry either: its `sac` clock starts on "protocolo colado", not on
     * entering the stage. Stamping a deadline here would drop a case the
     * person has not yet acted on into the deadline scan and start expiring
     * it. `stage` is written explicitly rather than left to the column
     * default so the decision is visible at the one place that makes it.
     *
     * **Why one query, and why the count check.** `findingIds` is
     * caller-supplied and is *not* covered by checking `invoiceId`: without
     * the `contestable.length !== findingIds.length` test below, a caller
     * could name its own invoice and slip somebody else's finding id into
     * the array, and the case - and later its dossier, and later still its
     * `recoveredCents` - would carry a stranger's money. So a single query
     * proves all of it at once (the invoice is this caller's, every finding
     * belongs to *that* invoice, none is shadow, each has a contestable
     * status) and the row count is what turns "some of them matched" into
     * "all of them did". `findings.id` is the primary key, so N rows back
     * for N deduped ids means every one of them passed.
     *
     * **The SELECT names the invoice twice, and both have to stay.** The
     * inner join is `findings.invoice_id = invoices.id`, so with it in place
     * `eq(invoices.id, input.invoiceId)` and `eq(findings.invoiceId,
     * input.invoiceId)` say the same thing about the same row: delete either
     * one on its own and no test in this repo changes colour. That is
     * precisely how both get deleted - one as "obviously redundant", the
     * other later for the same reason - so it is written down here. Jointly
     * they are the only thing tying the case to the invoice it claims to be
     * about: with neither, `ownsInvoice` still holds (it is a predicate on
     * `invoices`) and the count test still passes, but the caller may fill
     * the case with findings from *any other invoice of their own* while
     * `cases.invoiceId` says this one, and `issuerId` is then read off
     * whichever row came back first - a case addressed to the wrong company
     * about charges on a different bill. The test that goes red is "refuses
     * a finding of a different invoice of the same owner". Keep them as a
     * pair; `ownsInvoice` is the separate half that stops another *person's*
     * findings, and neither half substitutes for the other.
     *
     * **Issuer.** `cases.issuerId` is NOT NULL, and a case with no issuer
     * has no playbook (§20.2) to walk, so an owned invoice whose issuer was
     * never detected (RF-105/RF-106 leaves `invoices.issuerId` nullable)
     * yields `null` rather than a case that could never be escalated.
     *
     * **Why the same predicate is repeated on the UPDATE.** The validating
     * SELECT above runs outside the transaction, so on its own it settles
     * nothing about two callers racing: both can read the same finding as
     * contestable and both insert, leaving two live cases over the same
     * money and `recoveredCents` counted twice into §1.4's north-star
     * metric when both close. The invariant therefore lives in the *write*:
     * the flip to `contested` carries `shadow = false` and the contestable
     * status list in its own WHERE, and the case is only allowed to exist if
     * that UPDATE touched every finding it names. Under READ COMMITTED the
     * loser blocks on the row lock the winner already holds, re-reads the
     * row after the winner commits, matches zero rows, and the count test
     * rolls its whole transaction back - the insert, the flip and the event
     * together. (That paragraph describes production Postgres, and is
     * reasoned rather than tested: PGlite runs every transaction under one
     * mutex, so no test in this repo can put two of them in flight at once.
     * What the race test does prove is the other half - a second call whose
     * SELECT is already stale opens no case.) `FOR UPDATE` on the SELECT
     * would serialise the two callers too, but it would put the lock in a
     * statement that is not the one that has to hold it.
     *
     * **The two WHEREs are deliberately not identical.** The UPDATE omits
     * the invoice and ownership predicates because the SELECT above already
     * proved those about the very same ids, and it re-states the contestable
     * status list because that is the one thing that can have *changed*
     * between the two statements - another case taking the finding. That
     * status list is the load-bearing half. `shadow = false` is carried
     * along with it but decides nothing here: `findings.shadow` is written
     * once, at insert (`apps/jobs/src/tasks/ingest.ts`), and no statement in
     * this repo ever updates it, so a row the SELECT already excluded as
     * shadow cannot have become non-shadow by the time the UPDATE runs. It
     * is kept because a WHERE that mirrors the contestability rule in full
     * is easier to keep true than one that has been pruned to the subset
     * that happens to matter today - but nobody should read it as a second
     * gate. What the write guarantees on its own is
     * narrow but exact: no finding can enter two cases, whoever asks. What
     * it does *not* guarantee is ownership - a future caller that skipped
     * the SELECT could flip and contest another user's findings, since
     * nothing in this UPDATE mentions `invoices` at all. The SELECT is the
     * only thing standing between `findingIds` and INV-008, which is why it
     * is not an optimisation to be dropped later.
     *
     * **Several live cases may exist on one invoice, on purpose.** Nothing
     * here - and no constraint in `packages/db/src/schema.ts` - stops a
     * second `createCase` on the same `invoiceId` while the first case is
     * still open, and a test in `packages/db/test/cases.test.ts` now depends
     * on that ("does not touch findings of another case that shares the
     * invoice"). It is allowed because one bill can carry two arguments that
     * have nothing to do with each other - an SVA nobody signed up for and a
     * plan charged at the wrong price - and forcing them into one case would
     * make the person drop one to pursue the other, or withdraw both to
     * settle either. What is *not* allowed is the same money in two cases,
     * and that is the invariant `CONTESTABLE_FINDING_STATUSES` excluding
     * `contested` enforces, per finding rather than per invoice. The cost is
     * real and is accepted knowingly: two cases on one bill are two
     * escalation ladders against the same company, two clocks in E5 Task 3's
     * deadline scan and two dossiers in Task 7 - so anything walking cases
     * must handle siblings sharing an `invoiceId`, and must not assume it
     * can find "the" case for an invoice.
     *
     * Every rejection returns the same `null` - not owned, does not exist,
     * already contested, no issuer, and a lost race - so the caller (and
     * therefore the HTTP response) can never learn which one it was
     * (INV-008). The lost race returns `null` rather than throwing on
     * purpose: given the paragraph above, the only way to reach that branch
     * is contention, which is a property of the moment and not of the
     * request. A double-clicked submit is two concurrent requests under any
     * real pool, and it would be incoherent for the loser to get a 500 when
     * the *sequential* double-submit gets the 404 the design intends.
     * `apps/web/app/api/cases/route.ts` does not catch, so a throw here is a
     * 500 in production; 500s are worth paging on only while they still mean
     * a broken invariant.
     *
     * **Why this method records its own event**, when `editCaseDocument`
     * leaves `contest_edited` to its route: A3 says every state transition
     * writes an `events` row, and a case coming into existence is the first
     * such transition there is. `apps/jobs/src/tasks/ingest.ts` sets the
     * precedent - status and event land in the same transaction - and a
     * crash between a committed case and a route-written event would leave
     * a case whose creation the trail never recorded, with nothing left to
     * tell a repair job that the row is the one missing its event.
     */
    async createCase(input: { invoiceId: string; findingIds: string[] }) {
      if (!userId) return null;
      // First-seen order preserved: `findingIds` is stored as given and read
      // back by the dossier, so the order the person picked the charges in
      // is the order they get argued in.
      const findingIds = [...new Set(input.findingIds)];
      // Legibility only: behaviour is identical without this line. Drizzle
      // compiles `inArray(col, [])` to `false`, so an empty array falls
      // through to a zero-row SELECT, the count test rejects it, and the
      // `issuerId` test would reject it again. The test that covers it
      // therefore proves the *outcome*, not this guard - nobody should read
      // it as evidence the line is load-bearing.
      if (findingIds.length === 0) return null;

      const contestable = await db.select({ issuerId: invoices.issuerId })
        .from(findings)
        .innerJoin(invoices, eq(findings.invoiceId, invoices.id))
        .where(and(
          eq(invoices.id, input.invoiceId),
          ownsInvoice,
          eq(findings.invoiceId, input.invoiceId),
          inArray(findings.id, findingIds),
          eq(findings.shadow, false),
          inArray(findings.status, [...CONTESTABLE_FINDING_STATUSES]),
        ));
      if (contestable.length !== findingIds.length) return null;
      const issuerId = contestable[0]?.issuerId;
      if (!issuerId) return null;

      const id = newId("cas");
      const now = new Date();
      // One transaction - `apps/jobs/src/tasks/ingest.ts`'s pattern - holding
      // the case row, the flip to `contested` and the `case_created` event,
      // so all three commit or none do. A case whose findings never flipped
      // would leave the same money open to a second case, which is exactly
      // what `CONTESTABLE_FINDING_STATUSES` excluding `contested` prevents.
      try {
        await db.transaction(async (tx) => {
          await tx.insert(cases).values({
            id,
            userId,
            invoiceId: input.invoiceId,
            issuerId,
            findingIds,
            stage: "draft",
            nextDeadlineAt: null,
          });
          // The concurrency gate: the same contestability test the SELECT ran,
          // re-applied by the statement that actually takes the rows. A loser
          // racing for the same finding matches fewer rows than it named and
          // rolls the whole transaction back.
          const flipped = await tx.update(findings)
            .set({ status: "contested", updatedAt: now })
            .where(and(
              inArray(findings.id, findingIds),
              eq(findings.shadow, false),
              inArray(findings.status, [...CONTESTABLE_FINDING_STATUSES]),
            ))
            .returning({ id: findings.id });
          if (flipped.length !== findingIds.length) {
            throw new CaseFindingRaceLost(
              `createCase lost a race for ${findingIds.length - flipped.length} finding(s): ` +
              "another case took them between the check and the write",
            );
          }
          await tx.insert(events).values({
            id: newId("evt"),
            userId,
            invoiceId: input.invoiceId,
            caseId: id,
            type: "case_created" satisfies EventType,
            payload: { invoiceId: input.invoiceId, findingIds, stage: "draft" },
          });
        });
      } catch (error) {
        // Narrow on purpose: only the sentinel the gate above raises becomes
        // a `null`. Anything else out of the transaction - a constraint, a
        // connection that went away - is a genuine fault and keeps going up,
        // because the moment this catch stops being narrow it also stops
        // being possible to tell contention from a broken database.
        if (error instanceof CaseFindingRaceLost) return null;
        throw error;
      }
      return id;
    },

    /**
     * Everything one case's screen (and Task 7's dossier) reads, in one
     * round trip. Ownership is proved once, on the case itself, and the
     * three lists that hang off it are then scoped by `caseId` alone -
     * `case_documents` and `case_protocols` both cascade from `cases`, so a
     * row of either can only exist under a case already proved owned.
     *
     * A case belonging to somebody else and a case that never existed both
     * come back as the same `null` (INV-008): the caller, and therefore the
     * HTTP response, can never tell the two apart.
     *
     * **The timeline is NOT filtered by `ownsEvent`, and must not be.** It
     * is deliberately scoped on `events.caseId` alone, because ownership was
     * already settled one query earlier - on the case itself, which is the
     * row that actually has an owner. A per-event owner filter could
     * therefore only ever remove rows that belong on this case's history,
     * and what it would remove is decided by which writer happened to stamp
     * a `userId` on them: `events.user_id` is nullable, system jobs have no
     * user session to stamp from, and nothing constrains a row carrying this
     * `caseId` to carry this `userId` too. Adding the filter would make the
     * completeness of a person's own history depend on a column no writer is
     * obliged to fill - a case whose deadline expired could simply stop
     * saying so. (Do not restate this as a claim about what any particular
     * job writes today: E5 Task 3's `record()` helper does stamp `userId`
     * alongside `caseId` and `invoiceId` on every row, so "the deadline job
     * writes no `userId`" would be false, and a contributor who checked it,
     * found it false and "fixed" the comment by adding the owner filter
     * would be undoing the decision this paragraph exists to protect. The
     * reason is the one above, which does not depend on any writer's habits.)
     *
     * **Each list is ordered by its timestamp *and its id*.** `occurred_at`,
     * `created_at` and `registered_at` all default to `now()`, which in
     * Postgres is the *transaction's* start time, not the statement's - so
     * any writer emitting two rows in one transaction stamps them
     * identically. E5 Task 3's deadline job does exactly that, writing
     * `deadline_expired` and `stage_advanced` together, and `closeCase`
     * below writes `outcome_confirmed` and `stage_advanced` in one
     * transaction for the same reason. On the timestamp alone Postgres is
     * free to return tied rows in any order, and will change its mind as
     * soon as the plan changes, so "the deadline expired, then the stage
     * advanced" would read backwards at random. The `id` tiebreak makes the
     * order total and therefore stable; it is not a *chronological* claim
     * about tied rows (ids are random), only a deterministic one. E5 Task
     * 7's dossier already orders by `(occurredAt, id)`, so this is also what
     * keeps the two views of one history from disagreeing.
     */
    async caseDetail(caseId: string) {
      if (!userId) return null;
      const [row] = await db.select({
        id: cases.id,
        userId: cases.userId,
        invoiceId: cases.invoiceId,
        issuerId: cases.issuerId,
        findingIds: cases.findingIds,
        stage: cases.stage,
        stageEnteredAt: cases.stageEnteredAt,
        nextDeadlineAt: cases.nextDeadlineAt,
        workflowRunId: cases.workflowRunId,
        protocolToken: cases.protocolToken,
        outcome: cases.outcome,
        outcomeConfirmedBy: cases.outcomeConfirmedBy,
        recoveredCents: cases.recoveredCents,
        closedAt: cases.closedAt,
        createdAt: cases.createdAt,
        updatedAt: cases.updatedAt,
      })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.userId, userId)));
      if (!row) return null;

      // One round trip for the three lists: nothing among them depends on
      // anything but `caseId`, which the ownership query above already
      // proved, so they are issued together rather than in sequence.
      const [documents, protocols, timeline] = await Promise.all([
        db.select({
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
          .where(eq(caseDocuments.caseId, caseId))
          .orderBy(caseDocuments.createdAt, caseDocuments.id),

        db.select({
          id: caseProtocols.id,
          caseId: caseProtocols.caseId,
          stage: caseProtocols.stage,
          protocolNumber: caseProtocols.protocolNumber,
          channel: caseProtocols.channel,
          registeredAt: caseProtocols.registeredAt,
          responseDueAt: caseProtocols.responseDueAt,
          responseReceivedAt: caseProtocols.responseReceivedAt,
          responseSummary: caseProtocols.responseSummary,
          createdAt: caseProtocols.createdAt,
          updatedAt: caseProtocols.updatedAt,
        })
          .from(caseProtocols)
          .where(eq(caseProtocols.caseId, caseId))
          // `registeredAt` is when the company actually recorded the
          // protocol, which is the order a person reads their own history
          // in - not `createdAt`, which is only when this app got told.
          .orderBy(caseProtocols.registeredAt, caseProtocols.id),

        db.select({
          id: events.id,
          userId: events.userId,
          sessionId: events.sessionId,
          caseId: events.caseId,
          invoiceId: events.invoiceId,
          type: events.type,
          payload: events.payload,
          occurredAt: events.occurredAt,
        })
          .from(events)
          .where(eq(events.caseId, caseId))
          .orderBy(events.occurredAt, events.id),
      ]);

      return { case: row, documents, protocols, timeline };
    },

    /**
     * Closes a case and settles the findings it was disputing. Returns the
     * updated row - the caller still wants `invoiceId` and the values as
     * actually stored, even though the `outcome_confirmed` event is written
     * here rather than by the route.
     *
     * **Once, and only once.** `isNull(cases.closedAt)` *and* `ne(cases.stage,
     * "closed")` are folded into the same predicate as the ownership check
     * rather than tested beforehand, so the close is decided by the write
     * itself and two concurrent calls cannot both win it. A second close
     * therefore returns the same `null` a wrong owner gets, and can never
     * emit a second `outcome_confirmed` - `recoveredCents` feeds §1.4's
     * north-star metric ("R$ recuperados"), and a case that could report its
     * recovery twice would inflate the one number this product is measured
     * by.
     *
     * **Why both halves, when either looks sufficient.** Nothing in the
     * schema pairs them: `cases.stage = 'closed'` and `closed_at IS NOT
     * NULL` are two independent columns, and the only CHECK on `stage` is
     * its value list. This method writes both together, so on rows it wrote
     * the two are equivalent - and that is exactly why one of them alone is
     * a bad guard, because the rows that matter are the ones *something
     * else* wrote. `nextStage` returns `stage: "closed"` with an outcome for
     * its `resolved` and `user_abandon` events, and E5 Task 5's `/advance`
     * route applies whatever it returns: an advance that writes `stage` and
     * `outcome` without stamping `closed_at` produces a case that is closed
     * by every reading except this predicate's, and `isNull(closedAt)` alone
     * would happily close it again - a second `outcome_confirmed`, and the
     * same recovery counted twice into the metric. `ne(stage, "closed")`
     * covers that row; `isNull(closedAt)` covers the mirror case of a writer
     * that stamps the timestamp without moving the stage. Neither is
     * redundant until the schema makes them so.
     *
     * **What happens to the findings.** Findings this case named and that are
     * still `contested` become `resolved` on a `resolved` outcome and
     * `unresolved` on `partial`, `denied` and `abandoned`. `partial` landing
     * on `unresolved` is deliberate: a case records how much money came back
     * but never *which* findings the partial recovery covered, so marking
     * them all resolved would erase from the report exactly the charges
     * nobody actually got refunded. `unresolved` is in
     * `VISIBLE_FINDING_STATUSES` for that reason - the money stays on the
     * report, with a failed attempt behind it. The `contested` filter keeps
     * this case to its own business: a finding some other write already
     * settled is not this close's to move.
     *
     * **The findings UPDATE is scoped by `id ∈ case.findingIds AND status =
     * 'contested'` and by nothing else** - not by the case, because
     * `findings` has no `case_id`. It is safe only because of one invariant
     * held elsewhere: a finding can be `contested` by at most one case at a
     * time, which is what `CONTESTABLE_FINDING_STATUSES` excluding
     * `contested` gives `createCase`. Take that away and this statement
     * settles findings that belong to somebody's *other*, still-running
     * case. E6's `case_reopened` is the change that will take it away: a
     * reopen that clears `closed_at` without putting its findings back to
     * `contested` - or one that puts them back while a newer case is already
     * contesting them - lets this close reach findings it never named a
     * second time. Whoever builds `case_reopened` owns keeping the
     * one-case-per-finding invariant true, or this UPDATE needs a narrower
     * scope than `findings` can currently express.
     *
     * **Why this method records its own event**, when `editCaseDocument`
     * leaves `contest_edited` to its route: the close is deliberately
     * one-shot, so a route-written event is not merely late, it is
     * unrepairable. A crash between a committed close and the route's write
     * would leave a closed case whose `outcome_confirmed` can never be
     * written at all - the retry hits `isNull(cases.closedAt)`, gets the
     * same `null` a wrong owner gets, and A3's trail is permanently missing
     * the one row §1.4's north-star metric is computed from. Inside the
     * transaction, close and event commit or roll back together
     * (`apps/jobs/src/tasks/ingest.ts` is the precedent). The insert goes
     * straight against `tx`; `recordEvent` above closes over the
     * non-transactional `db` and would commit independently, which is
     * exactly the split this avoids.
     *
     * **And why it also writes `stage_advanced`, which no brief asked for.**
     * This close moves `cases.stage` to `closed` and restamps
     * `stageEnteredAt` - a stage transition, by every definition the rest of
     * E5 uses. E5 Task 3's abandonment sweep records `stage_advanced` for
     * that same column change, and Task 2's `next-stage.table.ts` instructs
     * E6 to recover a case's pre-close stage from "the last `stage_advanced`"
     * (RF-203 needs it: reopening a case has to know what to reopen it
     * *to*). If a user close wrote only `outcome_confirmed`, the trail would
     * have two different shapes for one column change depending on who
     * closed the case, and every reader would have to know both - or, more
     * likely, know one and be quietly wrong about the other half of the
     * cases. So both rows are written here, in the one transaction:
     * `outcome_confirmed` unchanged, saying how the dispute ended, and
     * `stage_advanced` carrying `from` (the stage this case actually left)
     * and `to: "closed"`. `from` is read under `FOR UPDATE` so it cannot be
     * a stale guess - the lock is only about the accuracy of that payload;
     * the UPDATE below is still the sole decider of whether the close
     * happens at all.
     *
     * **This is the only code that moves findings out of `contested`, and
     * that is a problem for whoever closes a case without it.** `closeCase`
     * is a `withUser` method, so a system job with no user session cannot
     * call it. E5 Task 3's day-60 abandonment sweep closes cases directly
     * against `cases`; unless it also settles `findings`, the findings those
     * cases named stay `contested` forever. Nothing else ever changes them:
     * they keep appearing on the report as actively disputed
     * (`VISIBLE_FINDING_STATUSES` includes `contested`), and they can never
     * enter another case (`CONTESTABLE_FINDING_STATUSES` excludes it). The
     * money is then unrecoverable through the product - on exactly the
     * charges §1.4's north-star metric is counted from, and for the people
     * whose case was abandoned because nothing happened, who are the least
     * likely to be told why. Any path that closes a case must settle its
     * findings in the same transaction, with the same mapping this method
     * uses.
     *
     * **`note` is masked here, not by the caller.** `cases` has no column
     * for it, so it lives only in the event payload - but INV-007 says PII
     * is masked before it is persisted, and free text a person types about
     * their own bill is precisely where a CPF turns up. `maskText` runs
     * inside this method rather than in the route because a masking step a
     * caller can forget is a masking step that will eventually be forgotten,
     * and the event row is durable.
     *
     * **`recoveredCents` is checked here too**, even though the route
     * validates its own body first. "Money is integer cents, always" has no
     * enforcement at this layer otherwise: a fractional value only fails at
     * the column, and a negative one succeeds and quietly *subtracts* from
     * the north-star metric. It throws rather than returning `null`, because
     * `null` means "no such case of yours", and a caller cannot be told a
     * bad argument is a missing row.
     *
     * An explicit `null` is treated exactly as an absent value, not as a bad
     * argument: JSON has no `undefined`, so "no amount" arrives from a body
     * as `null` as often as by omission, and the `?? 0` this method has
     * always applied would have accepted it. Rejecting it would have made a
     * key spelled out as null a 500 where the same key left out is a normal
     * close - a difference no caller could have predicted from the outside.
     */
    async closeCase(
      caseId: string,
      input: { outcome: CaseOutcome; recoveredCents?: number | null; note?: string },
    ) {
      if (!userId) return null;
      const recoveredCents = input.recoveredCents ?? 0;
      if (!Number.isInteger(recoveredCents) || recoveredCents < 0) {
        throw new Error(`closeCase: recoveredCents must be a non-negative integer of cents, got ${input.recoveredCents}`);
      }
      const now = new Date();
      return db.transaction(async (tx) => {
        // Read only for `stage_advanced`'s `from`: Postgres before 18 cannot
        // return a column's pre-UPDATE value, and the stage this case is
        // leaving is the one thing the close destroys. `FOR UPDATE` takes the
        // row lock here so a concurrent advance cannot move the stage between
        // this read and the UPDATE and leave the payload naming a stage the
        // case had already left. Ownership is folded in so a foreign case id
        // locks nothing; whether the close happens is still decided entirely
        // by the UPDATE's own predicate below, which is what makes a second
        // close impossible rather than merely unlikely.
        const [before] = await tx.select({ stage: cases.stage })
          .from(cases)
          .where(and(eq(cases.id, caseId), eq(cases.userId, userId)))
          .for("update");
        const [updated] = await tx.update(cases)
          .set({
            stage: "closed",
            // Stamped with the same instant as `closedAt`: without it the
            // row would keep claiming the case entered `closed` back when it
            // actually entered `sac`.
            stageEnteredAt: now,
            outcome: input.outcome,
            outcomeConfirmedBy: "user",
            recoveredCents,
            closedAt: now,
            nextDeadlineAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(cases.id, caseId),
            eq(cases.userId, userId),
            isNull(cases.closedAt),
            ne(cases.stage, "closed"),
          ))
          .returning();
        if (!updated) return null;
        await tx.update(findings)
          .set({
            status: input.outcome === "resolved" ? "resolved" : "unresolved",
            updatedAt: now,
          })
          .where(and(inArray(findings.id, updated.findingIds), eq(findings.status, "contested")));
        await tx.insert(events).values({
          id: newId("evt"),
          userId,
          invoiceId: updated.invoiceId,
          caseId: updated.id,
          type: "outcome_confirmed" satisfies EventType,
          payload: {
            outcome: updated.outcome,
            recoveredCents: updated.recoveredCents,
            confirmedBy: "user",
            ...(input.note === undefined ? {} : { note: maskText(input.note) }),
          },
        });
        // The same column change E5 Task 3's abandonment close records, so a
        // user close and a system close leave one shape of trail rather than
        // two. `from` is what E6's `case_reopened` reads to know which stage
        // to put the case back into (RF-203); `by` is what tells the two
        // apart without having to join back to `cases.outcome_confirmed_by`.
        await tx.insert(events).values({
          id: newId("evt"),
          userId,
          invoiceId: updated.invoiceId,
          caseId: updated.id,
          type: "stage_advanced" satisfies EventType,
          payload: { from: before?.stage ?? null, to: "closed", by: "user", outcome: updated.outcome },
        });
        return updated;
      });
    },
  };
}

export type ScopedDb = ReturnType<typeof withUser>;
