/**
 * External ANEEL reference data that RN-040 (tariff) and RN-041 (flag)
 * evaluate against. The engine cannot fetch this itself — RF-120 keeps it
 * free of I/O — so it arrives as part of `RuleEngineInput` instead.
 *
 * Shaped after `referenceTariffs` and `referenceFlags` in
 * packages/db/src/schema.ts: same field names, minus the bookkeeping
 * columns (`id`, `sourceUrl`, `importedAt`, `createdAt`, `updatedAt`) the
 * engine has no use for. Dates stay ISO strings and money stays integer
 * cents-per-unit, matching the rest of this package's domain types (see
 * `InvoiceCanonical`).
 */
export type ReferenceTariff = {
  issuerCnpj: string;
  subgroup: string; // e.g. "B1"
  modality: string; // e.g. "Convencional"
  className: string; // e.g. "Residencial"
  subClass: string;
  validFrom: string; // ISO date
  validTo: string | null; // ISO date, null = still in force
  tusdCentsMwh: number;
  teCentsMwh: number;
  // RN-040's first named trap (§12.3): ANEEL publishes several rows per
  // issuer/subgroup/period under different `DscBaseTarifa` values (e.g.
  // "Tarifa de Aplicação" vs. components like TUSD Fio B on their own).
  // Only "Tarifa de Aplicação" is the comparable, tax-exclusive all-in
  // rate RN-040 wants; the `reference` evaluator filters on this field
  // itself rather than trusting that whatever imported the row already
  // filtered it, because a wrong base tariff silently produces a false
  // accusation. Not yet a column on `packages/db`'s `reference_tariffs`
  // table (the ANEEL import is out of scope for E2 — see the plan's
  // self-review) — that table will need this column before real data can
  // flow through this filter in production.
  dscBaseTarifa: string;
};

export const TARIFF_FLAGS = ["verde", "amarela", "vermelha_1", "vermelha_2", "escassez"] as const;
export type TariffFlag = (typeof TARIFF_FLAGS)[number];

export type ReferenceFlag = {
  competence: string; // ISO date, first day of the billing month
  flag: TariffFlag;
  valueCentsPer100Kwh: number;
};
