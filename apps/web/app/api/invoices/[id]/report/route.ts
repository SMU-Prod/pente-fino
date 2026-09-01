import { cookies } from "next/headers";
import { withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";

type FindingRow = Awaited<ReturnType<ReturnType<typeof withUser>["findingsForInvoice"]>>[number];

/**
 * RF-124's three display bands, keyed off `confidence` alone. This route
 * only classifies - the pt-BR wording ("verificar", "provável cobrança a
 * contestar", the question text itself) is chosen by the interface, per
 * PRD §13.3 ("confiança sempre visível... em linguagem simples e não em
 * número cru"). Boundaries are inclusive on the low end of each band:
 * exactly 0,55 already reads as "verificar", exactly 0,8 still does too -
 * only strictly above 0,8 becomes "likely".
 */
type Band = "question" | "verify" | "likely";

function confidenceBand(confidence: number): Band {
  if (confidence < 0.55) return "question";
  if (confidence <= 0.8) return "verify";
  return "likely";
}

/**
 * Plain-cents BRL formatting, deliberately not `Intl.NumberFormat`: pt-BR's
 * ICU output separates "R$" from the digits with a non-breaking space
 * (U+00A0), not the plain ASCII space PRD §10's RF-128 acceptance example is
 * written with ("R$ 51,60") - matching that example byte-for-byte needs a
 * formatter that never introduces one.
 */
function formatCentsBRL(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centavos = String(abs % 100).padStart(2, "0");
  return `${sign}R$ ${reais},${centavos}`;
}

const MIN_CLUSTER_SIZE = 3; // RF-128

/**
 * RF-128: 3+ findings sharing a section (within this one invoice - "ciclo"
 * is automatically satisfied since a report is already scoped to a single
 * invoice/billing cycle) collapse into one aggregate, shown above the
 * individual lines rather than replacing them. This is a display-only view
 * over the same findings, computed at read time - it is never persisted and
 * never folded into `totals`, which sum the real per-finding amounts
 * exactly once, before this synthetic entry is prepended to the array the
 * response returns.
 */
function buildAggregates(rows: FindingRow[]) {
  const bySection = new Map<string, FindingRow[]>();
  for (const row of rows) {
    if (!row.section) continue;
    const group = bySection.get(row.section) ?? [];
    group.push(row);
    bySection.set(row.section, group);
  }

  return [...bySection.entries()]
    .filter(([, group]) => group.length >= MIN_CLUSTER_SIZE)
    .map(([section, group]) => {
      const amountCents = group.reduce((acc, f) => acc + f.amountCents, 0);
      const doubledSum = group.reduce((acc, f) => acc + (f.doubledCents ?? 0), 0);
      const confidence = Math.max(...group.map((f) => f.confidence));
      return {
        id: `agg:${section}`,
        aggregate: true as const,
        itemId: null,
        confidence,
        band: confidenceBand(confidence),
        evidence: [`${formatCentsBRL(amountCents)} em ${group.length} ${section.toLowerCase()}`],
        amountCents,
        doubledCents: doubledSum > 0 ? doubledSum : null,
      };
    });
}

/**
 * INV-008: the read path is the one place a leak would matter most - this
 * is the route a shared link, a bookmark, or simple id-guessing would try
 * first. `withUser` scopes both `invoices()` and `findingsForInvoice()` to
 * the caller's own session, and "no valid session" and "valid session, not
 * the owner" are handled by two different, deliberately non-overlapping
 * codes: `forbidden` (identity unknown) vs. `not_found` (identity known,
 * but this is not theirs) - one session can never distinguish "this invoice
 * does not exist" from "this invoice exists and is someone else's" once it
 * has proven who it is.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db } = container();
  const scoped = withUser({ sessionId }, db);
  const invoice = (await scoped.invoices()).find((row) => row.id === id);
  if (!invoice) return apiError("not_found");

  // RF-125: `findingsForInvoice` already excludes `shadow` rows, so both the
  // totals below and the list this route returns are blind to a rule still
  // on probation - a shadow finding cannot show and cannot inflate the
  // amount a user is told is at stake.
  const rows = await scoped.findingsForInvoice(id);
  const suspectCents = rows.reduce((acc, f) => acc + f.amountCents, 0);
  const doubledCents = rows.reduce((acc, f) => acc + (f.doubledCents ?? 0), 0);

  const aggregates = buildAggregates(rows);
  const visible = rows.map(({ ruleSpec, section: _section, ...finding }) => ({
    ...finding,
    band: confidenceBand(finding.confidence),
    // RF-124: a `confirm`-kind rule's finding carries the question the
    // interface should ask instead of this route asserting anything about
    // the charge - `ruleSpec` is only ever present to derive `askUser` from,
    // never returned itself.
    ...(ruleSpec.kind === "confirm" ? { askUser: { question: ruleSpec.question, options: ruleSpec.options } } : {}),
  }));

  // PRD §8.2 declares `issuer` in this response's shape; loaded through the
  // same ownership-scoped path (`scoped`, from `withUser`) as `findings`
  // above, and `null` when the invoice has no issuer assigned yet.
  const issuer = await scoped.issuerForInvoice(id);

  await scoped.recordEvent("report_viewed", {}, id);
  return Response.json({
    invoice,
    // RF-128: the aggregate(s), if any, lead the list - the acceptance
    // example is literally "before the individual lines".
    findings: [...aggregates, ...visible],
    totals: { suspectCents, doubledCents },
    issuer,
  });
}
