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
};

export const TARIFF_FLAGS = ["verde", "amarela", "vermelha_1", "vermelha_2", "escassez"] as const;
export type TariffFlag = (typeof TARIFF_FLAGS)[number];

export type ReferenceFlag = {
  competence: string; // ISO date, first day of the billing month
  flag: TariffFlag;
  valueCentsPer100Kwh: number;
};
