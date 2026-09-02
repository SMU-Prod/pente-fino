/**
 * The one place this monorepo formats a money value or a civil date for a
 * Brazilian reader. It lives at the root of `packages/core` rather than
 * inside `rules/` or `documents/` because both of those — and `apps/jobs`'s
 * PDF renderer — need the identical output: RF-187's dossier prints the same
 * invoice total twice on the same page, once from `buildDossier`'s timeline
 * and once from the renderer's invoice section, and a second private copy of
 * `formatCents` is exactly how those two came to disagree above
 * R$ 1.000,00 (`R$ 1189,90` vs `R$ 1.189,90`) and on a credit line
 * (`R$ -1,50` vs `-R$ 1,50`).
 *
 * Pure: no `Intl`, no locale, no timezone database, no clock.
 */

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Formats integer cents as a pt-BR money string ("R$ 1.234,56") without
 * `Intl`/locale support, whose availability differs between the Windows dev
 * machine and Linux CI this project targets — and whose pt-BR output
 * separates "R$" from the digits with a non-breaking space (U+00A0), not the
 * plain ASCII space PRD §10's RF-128 acceptance example is written with.
 * Pure integer arithmetic throughout - never divides by 100 into a float
 * before formatting - so there is no floating-point rounding risk either.
 * A negative amount (a credit line is a real thing on an invoice) puts its
 * sign before the currency symbol: `-R$ 1,50`.
 */
export function formatCentsBRL(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const reais = Math.trunc(abs / 100);
  const centavos = abs % 100;
  const reaisWithSeparators = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${reaisWithSeparators},${pad2(centavos)}`;
}

/**
 * `dd/MM/yyyy` built from a `Date`'s own UTC getters, so it is deterministic
 * and needs no timezone database. A civil date shown to a Brazilian reader
 * is, strictly, a function of their local timezone, not of UTC — reading a
 * UTC instant's date fields can be off by one day right around midnight in
 * some timezones. That is a known simplification this codebase does not
 * solve; it is confined to this one function.
 */
export function formatUtcDate(date: Date): string {
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/**
 * `YYYY-MM-DD` -> `dd/MM/yyyy`. The Postgres columns these come from
 * (`invoices.periodStart`/`periodEnd`/`dueDate`) are `date`, with no time
 * component at all, so splitting the string is both simpler and stricter
 * than routing it through `Date` and back.
 *
 * The value still crosses a boundary TypeScript does not check here
 * (`noUncheckedIndexedAccess` types the destructured parts as
 * `string | undefined`), so a malformed value falls back to the raw string
 * rather than silently rendering `undefined/undefined/2026`.
 */
export function formatIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return iso;
  }
  return `${day}/${month}/${year}`;
}

/** `formatIsoDate`, with the pt-BR wording for a column that holds no date. */
export function formatIsoDateOrUnknown(iso: string | null): string {
  return iso !== null ? formatIsoDate(iso) : "não informado";
}
