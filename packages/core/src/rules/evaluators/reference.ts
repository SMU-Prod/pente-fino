import type { ActiveRule } from "../engine.js";
import type { Finding } from "../finding.js";
import { normalizeDescription } from "../../invoice/normalize.js";
import type { ReferenceFlag, ReferenceTariff } from "../references.js";
import type { EvaluationContext } from "./types.js";

type Invoice = EvaluationContext["invoice"];

/**
 * `reference` compares the invoice against external ANEEL/CDC data
 * (RN-040, RN-041; RN-042/`cdc_limits` are out of scope - see below). With
 * no reference data for the invoice's issuer/competence, it produces
 * nothing rather than comparing against zero or a wrong row - a missing
 * table is not evidence of anything.
 *
 * ## RN-040 (`aneel_tariff`) - the traps named in §12.3, each handled below
 *
 * - **`DscBaseTarifa` filter.** ANEEL publishes several rows per
 *   issuer/period under different tariff bases; only
 *   `"Tarifa de Aplicação"` is the comparable all-in rate. Every other row
 *   is discarded before matching, even if it is the only row available -
 *   {@link reference.test.ts}'s dedicated regression test proves this.
 * - **Unit.** The table is R$/MWh; the invoice's declared unit price is
 *   R$/kWh. Rather than dividing the reference by 1000 (introducing a
 *   fraction that generally has no exact integer-cents representation),
 *   the invoice's value is multiplied by 1000 instead - multiplication of
 *   two exact integers never loses precision, division by 1000 can.
 * - **Tax gross-up**, read from the invoice, never fixed: `tarifa_com =
 *   tarifa_sem / (1 - (pis+cofins)) / (1 - icms)`. Missing any of the
 *   three on the invoice means the gross-up cannot be computed
 *   confidently, so nothing is produced.
 * - **Pro-ration.** When a tariff revision falls mid-cycle, more than one
 *   row can overlap the invoice's period. This evaluator only proceeds
 *   when the overlapping rows form an *exact, contiguous partition* of
 *   the period (no gap, no overlap between them) and takes a
 *   day-weighted average across them. Two rows that both cover the whole
 *   period (e.g. two different, unrecorded subclasses - `InvoiceCanonical`
 *   carries no subgroup/modality/class to disambiguate) fail that check
 *   and produce nothing, rather than guessing which one applies.
 * - **Join by CNPJ**, never by issuer name/acronym - `ReferenceTariff` has
 *   no name field to join on in the first place, and an invoice with no
 *   recorded CNPJ cannot be joined at all.
 *
 * All arithmetic from the day-weighted average through the gross-up and
 * the tolerance comparison is done as exact `bigint` fractions; only the
 * final disputed amount is rounded to the nearest cent, once. A relative
 * deviation computed as a chain of floating-point divisions can land a
 * hair under a mathematically-exact boundary (see `delta.ts` for a
 * concrete example of the same class of bug) and this evaluator's whole
 * purpose is a monetary yes/no decision, so it never risks that here.
 * `tolerancePct` is exclusive at the boundary: a deviation of *exactly*
 * `tolerancePct` is still within tolerance, matching the everyday reading
 * of "tolerance" as a band you are allowed to sit inside.
 *
 * ## RN-041 (`aneel_flag`)
 *
 * The rule is a single arithmetic comparison once phrased correctly:
 * "the surcharge charged differs from the value in force for the
 * competence" already covers "applied in a green month" as the special
 * case where the value in force is zero. The expected surcharge is
 * `0` for a `"verde"` competence (regardless of consumption - the check
 * that matters most does not depend on knowing kWh at all) or
 * `kwh * valueCentsPer100Kwh / 100` otherwise. The amount actually
 * charged is read from the invoice's own line items: any item whose
 * normalised description contains the token `"BANDEIRA"`. Zero such
 * items is read as "no surcharge was charged" (0); more than one is
 * ambiguous and produces nothing.
 *
 * ## `cdc_limits`
 *
 * No reference table exists anywhere in this system for CDC-mandated
 * limits (RN-009/RN-010 read as fixed constants against the invoice
 * itself, not against imported reference data) - the ANEEL/CDC data
 * import is out of scope for E2 (see the plan's self-review). This
 * evaluator therefore always produces nothing for this source, which is
 * the same "no reference data supplied" rule applied to a source that has
 * no data at all yet, not a special case.
 */
export function reference(rule: ActiveRule, ctx: EvaluationContext): Finding[] {
  if (rule.spec.kind !== "reference") return [];
  switch (rule.spec.source) {
    case "aneel_tariff":
      return aneelTariffFindings(rule, ctx.invoice, ctx.references.tariffs, rule.spec.tolerancePct);
    case "aneel_flag":
      return aneelFlagFindings(rule, ctx.invoice, ctx.references.flags, rule.spec.tolerancePct);
    case "cdc_limits":
      return [];
  }
}

// ---------------------------------------------------------------------------
// RN-040 - aneel_tariff
// ---------------------------------------------------------------------------

const APPLICATION_BASE = "Tarifa de Aplicação";
const DAY_MS = 86_400_000;
const SCALE = 1_000_000n; // fixed-point scale for the one-time tax-rate conversion

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

type Rational = { numerator: bigint; denominator: bigint };

type TariffOverlap = { tariff: ReferenceTariff; startDay: number; endDay: number };

function matchingOverlaps(
  tariffs: ReferenceTariff[],
  cnpj: string,
  periodStartDay: number,
  periodEndDay: number,
): TariffOverlap[] {
  const overlaps: TariffOverlap[] = [];
  for (const tariff of tariffs) {
    if (tariff.issuerCnpj !== cnpj) continue;
    if (tariff.dscBaseTarifa !== APPLICATION_BASE) continue;
    const validFromDay = dayNumber(tariff.validFrom);
    const validToDay = tariff.validTo === null ? periodEndDay : dayNumber(tariff.validTo);
    const startDay = Math.max(validFromDay, periodStartDay);
    const endDay = Math.min(validToDay, periodEndDay);
    if (startDay > endDay) continue;
    overlaps.push({ tariff, startDay, endDay });
  }
  return overlaps;
}

/**
 * Whether `overlaps` forms an exact, contiguous, non-overlapping partition
 * of `[periodStartDay, periodEndDay]`. Returns the overlaps sorted by
 * start day when it does, `null` when there is any gap or overlap - the
 * caller must not guess which row applies in that case.
 */
function asExactPartition(
  overlaps: TariffOverlap[],
  periodStartDay: number,
  periodEndDay: number,
): TariffOverlap[] | null {
  if (overlaps.length === 0) return null;
  const sorted = [...overlaps].sort((a, b) => a.startDay - b.startDay);
  if (sorted[0]!.startDay !== periodStartDay) return null;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startDay !== sorted[i - 1]!.endDay + 1) return null;
  }
  if (sorted[sorted.length - 1]!.endDay !== periodEndDay) return null;
  return sorted;
}

/** Day-weighted average of `tusdCentsMwh + teCentsMwh` across a partition, as an exact fraction. */
function weightedSem(partition: TariffOverlap[]): Rational {
  let numerator = 0n;
  let denominator = 0n;
  for (const { tariff, startDay, endDay } of partition) {
    const days = BigInt(endDay - startDay + 1);
    const semForRow = BigInt(tariff.tusdCentsMwh + tariff.teCentsMwh);
    numerator += semForRow * days;
    denominator += days;
  }
  return { numerator, denominator };
}

/** `sem / (1 - (pis+cofins)) / (1 - icms)`, as an exact fraction, in cents/MWh. */
function grossUp(sem: Rational, pis: number, cofins: number, icms: number): Rational {
  const pisCofinsScaled = BigInt(Math.round((pis + cofins) * 1_000_000));
  const icmsScaled = BigInt(Math.round(icms * 1_000_000));
  const denom1 = SCALE - pisCofinsScaled; // (1 - (pis+cofins)) * 1e6
  const denom2 = SCALE - icmsScaled; // (1 - icms) * 1e6
  return {
    numerator: sem.numerator * SCALE * SCALE,
    denominator: sem.denominator * denom1 * denom2,
  };
}

/** Rounds a non-negative `numerator/denominator` fraction to the nearest integer. */
function roundRational(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function hasCompleteTaxData(
  tariffs: Invoice["tariffs"],
): tariffs is NonNullable<Invoice["tariffs"]> & { pis: number; cofins: number; icms: number } {
  return (
    tariffs !== undefined &&
    typeof tariffs.pis === "number" &&
    typeof tariffs.cofins === "number" &&
    typeof tariffs.icms === "number"
  );
}

function aneelTariffFindings(
  rule: ActiveRule,
  invoice: Invoice,
  tariffs: ReferenceTariff[],
  tolerancePct: number,
): Finding[] {
  if (tariffs.length === 0) return [];
  const cnpj = invoice.issuer.cnpj;
  if (cnpj === undefined) return []; // cannot join without a CNPJ
  if (!hasCompleteTaxData(invoice.tariffs)) return [];
  const { teCentsKwh, tusdCentsKwh, pis, cofins, icms } = invoice.tariffs;
  if (teCentsKwh === undefined || tusdCentsKwh === undefined) return [];
  const kwh = invoice.readings?.kwh;
  if (kwh === undefined) return []; // no consumption to price the dispute against

  const periodStartDay = dayNumber(invoice.period.start);
  const periodEndDay = dayNumber(invoice.period.end);
  const overlaps = matchingOverlaps(tariffs, cnpj, periodStartDay, periodEndDay);
  const partition = asExactPartition(overlaps, periodStartDay, periodEndDay);
  if (partition === null) return []; // no coverage, or an ambiguous/overlapping match

  const sem = weightedSem(partition);
  const com = grossUp(sem, pis, cofins, icms);

  const invoiceCentsPerMwh = BigInt(teCentsKwh + tusdCentsKwh) * 1000n;
  // relative deviation = |invoiceCentsPerMwh - com| / com
  //   = |invoiceCentsPerMwh*denominator - numerator| / numerator   (since com*denominator = numerator)
  // Deliberately symmetric: RN-040 states the tolerance as "±0,5%/±2%" and
  // asks whether the billed unit price *diverges* from the homologated
  // one, not only whether it is higher. A rate billed suspiciously low can
  // itself be a sign of a miscalculated tariff (e.g. compensated by an
  // inflated consumption elsewhere), so both directions are worth
  // surfacing "para você verificar" - unlike `delta`'s `amount`, which
  // only ever fires on an increase because it is comparing the same
  // charge over time, not checking it against an external, authoritative
  // rate.
  const diffNumerator = invoiceCentsPerMwh * com.denominator - com.numerator;
  const absDiffNumerator = diffNumerator < 0n ? -diffNumerator : diffNumerator;
  const toleranceScaled = BigInt(Math.round(tolerancePct * 1_000_000));
  const exceeds = absDiffNumerator * 100n * 1_000_000n > toleranceScaled * com.numerator;
  if (!exceeds) return [];

  const kwhScaled = BigInt(Math.round(kwh * 1000));
  const amountNumerator = absDiffNumerator * kwhScaled;
  const amountDenominator = com.denominator * 1000n * 1000n; // /1000 for cents/kWh, /1000 to apply kwhScaled
  const amountCents = Number(roundRational(amountNumerator, amountDenominator));

  return [
    buildFinding(rule, amountCents, [
      "O valor unitário de energia cobrado nesta fatura diverge da tarifa homologada pela " +
        "ANEEL para este CNPJ e período, já considerando os tributos - para você verificar.",
    ]),
  ];
}

// ---------------------------------------------------------------------------
// RN-041 - aneel_flag
// ---------------------------------------------------------------------------

function competenceOf(invoice: Invoice): string {
  return `${invoice.period.start.slice(0, 7)}-01`;
}

function bandeiraSurchargeCents(invoice: Invoice): number | null {
  const matches = invoice.sections.flatMap((section) =>
    section.items.filter((item) => normalizeDescription(item.description).split(" ").includes("BANDEIRA")),
  );
  if (matches.length === 0) return 0; // no surcharge line: read as nothing charged
  if (matches.length > 1) return null; // ambiguous: more than one candidate line
  return matches[0]!.amountCents;
}

function aneelFlagFindings(
  rule: ActiveRule,
  invoice: Invoice,
  flags: ReferenceFlag[],
  tolerancePct: number,
): Finding[] {
  if (flags.length === 0) return [];
  const competence = competenceOf(invoice);
  const referenceFlag = flags.find((flag) => flag.competence === competence);
  if (referenceFlag === undefined) return [];

  const actual = bandeiraSurchargeCents(invoice);
  if (actual === null) return []; // ambiguous which line is the surcharge

  let expected: number;
  if (referenceFlag.flag === "verde") {
    expected = 0;
  } else {
    const kwh = invoice.readings?.kwh;
    if (kwh === undefined) return []; // cannot price the expected surcharge
    expected = Math.round((kwh * referenceFlag.valueCentsPer100Kwh) / 100);
  }

  const withinTolerance =
    expected === 0 ? actual === 0 : Math.abs(actual - expected) * 100 <= tolerancePct * expected;
  if (withinTolerance) return [];

  return [
    buildFinding(rule, Math.abs(actual - expected), [
      "O adicional de bandeira tarifária cobrado nesta fatura não corresponde ao valor vigente " +
        "para a competência - para você verificar.",
    ]),
  ];
}

// ---------------------------------------------------------------------------

function buildFinding(rule: ActiveRule, amountCents: number, evidence: string[]): Finding {
  return {
    ruleSlug: rule.slug,
    ruleVersion: rule.version,
    itemId: null,
    amountCents,
    doubledCents: null,
    confidence: rule.confidenceBase,
    evidence,
    legalBasis: rule.legalBasis,
    shadow: rule.shadow,
  };
}
