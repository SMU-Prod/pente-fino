import { eq, isNotNull } from "drizzle-orm";
import { getUnscopedDb } from "./client.js";
import { invoices, users } from "./schema.js";

type Db = ReturnType<typeof getUnscopedDb>;

/**
 * RF-245's acceptance is *"sem consentimento, a fatura não alimenta
 * `aggregates`"* — and nothing writes `aggregates` yet; that pipeline
 * arrives with E10/E11. So this function is not a filter bolted onto an
 * existing writer, it is the whole requirement, built ahead of the writer
 * that will need it: the only honest way to guarantee a future job cannot
 * get consent wrong is to make the query it *must* call the only place that
 * decides eligibility at all, and to build that query before anything is
 * under deadline pressure to skip it.
 *
 * Every job in this repo that now runs on a schedule — `expire-files.ts`,
 * the deadline sweep, `dossier.ts` — sat "registered, tested, and never run
 * by anything" before its scheduler entry existed (see `cron.test.ts`'s own
 * drift-guard comment). A bare eligibility function nobody is obliged to
 * call is exactly that same state, one step earlier: capable, not live.
 * The companion drift guard in `packages/db/test/aggregates-drift.test.ts`
 * is what keeps that gap from being filled the wrong way in the meantime —
 * it fails the build the moment any module other than this one reaches for
 * the `aggregates` table, so the day a real pipeline is built, this
 * function is the only place left for it to start from.
 *
 * **Deliberately not a `withUser` method**, following the precedent
 * `closeCaseAsSystem` sets in `case-close.ts`: a nightly aggregation run has
 * no user session to scope to, and INV-008 is about a *user's* query
 * reaching another user's data, not about a system job reading rows nobody
 * supplied it. It hands out no raw data access of its own kind either —
 * every row it returns is an invoice whose owner already said yes, and the
 * owner check is baked into the query, not left for the caller to remember.
 *
 * **Why an inner join, not a `WHERE user_id IS NOT NULL AND ...`
 * sub-select.** An invoice still owned by an anonymous session
 * (`invoices.user_id IS NULL`) has no `users` row to join against at all —
 * there is no one who could have consented, and no one to ask — so an
 * `INNER JOIN` against `users` excludes it structurally, the same way
 * `cases.userId` being `NOT NULL` makes an anonymous case impossible rather
 * than merely unlikely (see `withUser`'s own doc comment). A registered
 * user whose `aggregate_consent_at` is `NULL` — never granted, or granted
 * and later withdrawn (`setAggregateConsent` in `with-user.ts`) — joins
 * successfully but is filtered out by `isNotNull` below; both non-consenting
 * shapes are refused by the same predicate, not two.
 */
export async function invoicesEligibleForAggregation(db: Db) {
  const rows = await db.select({ invoice: invoices })
    .from(invoices)
    .innerJoin(users, eq(invoices.userId, users.id))
    .where(isNotNull(users.aggregateConsentAt));
  return rows.map((row) => row.invoice);
}
