import { formatCentsBRL, type Finding } from "@pentefino/core";
import type { ScopedDb } from "@pentefino/db";

export type AskUser = NonNullable<Finding["askUser"]>;

type FindingRow = Awaited<ReturnType<ScopedDb["findingsForInvoice"]>>[number];
export type InvoiceRow = Awaited<ReturnType<ScopedDb["invoices"]>>[number];
export type IssuerRow = Awaited<ReturnType<ScopedDb["issuerForInvoice"]>>;

/**
 * RF-124's three display bands, keyed off `confidence` alone. This module
 * only classifies - the pt-BR wording ("verificar", "provável cobrança a
 * contestar", the question text itself) is chosen by the interface, per
 * PRD §13.3 ("confiança sempre visível... em linguagem simples e não em
 * número cru"). Boundaries are inclusive on the low end of each band:
 * exactly 0,55 already reads as "verificar", exactly 0,8 still does too -
 * only strictly above 0,8 becomes "likely".
 */
export type ReportBand = "question" | "verify" | "likely";

export function confidenceBand(confidence: number): ReportBand {
  if (confidence < 0.55) return "question";
  if (confidence <= 0.8) return "verify";
  return "likely";
}

export type ReportFinding = Omit<FindingRow, "ruleSpec" | "section"> & {
  band: ReportBand;
  askUser?: AskUser;
};

export type ReportAggregate = {
  id: string;
  aggregate: true;
  itemId: null;
  confidence: number;
  band: ReportBand;
  evidence: string[];
  amountCents: number;
  doubledCents: number | null;
};

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
export function buildAggregates(rows: FindingRow[]): ReportAggregate[] {
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

export type Report = {
  invoice: InvoiceRow;
  findings: Array<ReportAggregate | ReportFinding>;
  totals: { suspectCents: number; doubledCents: number };
  issuer: IssuerRow;
};

/**
 * INV-008: the read path is the one place a leak would matter most - both
 * `GET /api/invoices/:id/report` and the `/laudo/[id]` server component call
 * this against their own `withUser`-scoped session, so ownership is always
 * enforced by the caller's `scoped` before this function ever runs. Returns
 * `null` when the invoice does not exist or is not owned by this session -
 * the two callers turn that into `not_found` (never `forbidden`, which is
 * reserved for "no session at all") so a caller can never learn which case
 * it was.
 *
 * Deliberately does not record `report_viewed` itself: that is a side
 * effect of a *view* happening, and the two callers - the JSON route and the
 * page - each are one, so each records its own event. Keeping this function
 * a pure read keeps it usable anywhere a report's shape is needed without
 * silently emitting an event neither caller asked for.
 */
export async function loadReport(scoped: ScopedDb, invoiceId: string): Promise<Report | null> {
  const invoice = (await scoped.invoices()).find((row) => row.id === invoiceId);
  if (!invoice) return null;

  // RF-125: `findingsForInvoice` already excludes `shadow` rows, so both the
  // totals below and the list this returns are blind to a rule still on
  // probation - a shadow finding cannot show and cannot inflate the amount a
  // user is told is at stake.
  const rows = await scoped.findingsForInvoice(invoiceId);
  const suspectCents = rows.reduce((acc, f) => acc + f.amountCents, 0);
  const doubledCents = rows.reduce((acc, f) => acc + (f.doubledCents ?? 0), 0);

  const aggregates = buildAggregates(rows);
  const visible: ReportFinding[] = rows.map(({ ruleSpec, section: _section, ...finding }) => ({
    ...finding,
    band: confidenceBand(finding.confidence),
    // RF-124: a `confirm`-kind rule's finding carries the question the
    // interface should ask instead of this function asserting anything
    // about the charge - `ruleSpec` is only ever present to derive
    // `askUser` from, never returned itself.
    ...(ruleSpec.kind === "confirm" ? { askUser: { question: ruleSpec.question, options: ruleSpec.options } } : {}),
  }));

  const issuer = await scoped.issuerForInvoice(invoiceId);

  return {
    invoice,
    // RF-128: the aggregate(s), if any, lead the list - the acceptance
    // example is literally "before the individual lines".
    findings: [...aggregates, ...visible],
    totals: { suspectCents, doubledCents },
    issuer,
  };
}
