import { and, eq, exists, gte, lte, sql } from "drizzle-orm";
import { getUnscopedDb } from "./client.js";
import { caseProtocols, cases } from "./schema.js";

type Db = ReturnType<typeof getUnscopedDb>;

/**
 * RF-204's public metric, verbatim: "recoveredCents só é somado quando
 * outcomeConfirmedBy = diff e havia protocolo. Aceite: métrica pública
 * nunca inclui auto-relato sem protocolo." §1.4 names this exact figure -
 * "reais recuperados confirmados por usuário ativo/mês" - as the number this
 * product is judged by, so both halves of RF-204's rule are enforced as
 * their own filter here, not folded into one another:
 *
 *   - `outcome_confirmed_by = 'diff'` excludes every close a *person*
 *     confirmed themselves (`user`) or nobody confirmed at all (`none`,
 *     RF-186's abandonment) - only a diff between two invoices, evidence
 *     this system produced on its own, backs the number.
 *   - The `case_protocols` existence check excludes a diff close with no
 *     paper trail behind it - RF-204's "auto-relato sem protocolo" is
 *     exactly a confirmation with nothing a person or a company can be
 *     asked to corroborate.
 *
 * **Both filters are written even though, at this writing, `reopenCase`
 * and Task 4's diff-close job together mean every diff-confirmed close ever
 * has a protocol** (a diff close only ever happens to a case that has
 * already escalated past `draft`, which requires a protocol to reach). That
 * is not a reason to drop the second filter - RF-204's acceptance is a
 * statement about *this query*, not about what today's one writer happens to
 * produce, and a metric that is correct only because its writer is correct
 * today is one refactor of that writer away from silently reporting a
 * self-confirmed recovery with no paper trail behind it, on the one number
 * the whole product is measured by.
 *
 * `exists`, correlated on `case_protocols.case_id = cases.id`, rather than a
 * join: a case can carry more than one protocol row (one per stage a
 * dispute passes through - `recordProtocol`'s own doc comment), and a join
 * would multiply a matching case's `recoveredCents` into the sum once per
 * protocol row instead of once per case.
 *
 * `range`, when given, filters on `cases.closed_at` - the instant the money
 * a row counts was actually confirmed - rather than `created_at` (when the
 * dispute opened, which can be months earlier) or `updated_at` (which an
 * unrelated later write could bump).
 *
 * Returns integer cents, `0` for an empty match - never `null`: a caller
 * dividing this into a per-user or per-month average always has a number to
 * divide by, never a value it has to null-check first. The driver returns a
 * SQL `sum()` over an `integer` column as a `bigint`-shaped string rather
 * than a JS number (Postgres protocol convention, to avoid silently losing
 * precision above 2^31); `Number(...)` is safe here up to 2^53, which is
 * far beyond any figure this metric will produce and matches how `cases.
 * recovered_cents` is read everywhere else in this package.
 */
export async function confirmedRecoveredCents(
  db: Db,
  range?: { from?: Date; to?: Date },
): Promise<number> {
  const conditions = [
    eq(cases.outcomeConfirmedBy, "diff"),
    exists(
      db.select({ id: caseProtocols.id })
        .from(caseProtocols)
        .where(eq(caseProtocols.caseId, cases.id)),
    ),
  ];
  if (range?.from) conditions.push(gte(cases.closedAt, range.from));
  if (range?.to) conditions.push(lte(cases.closedAt, range.to));

  const [row] = await db.select({
    total: sql<string>`coalesce(sum(${cases.recoveredCents}), 0)`,
  })
    .from(cases)
    .where(and(...conditions));

  return Number(row?.total ?? 0);
}
