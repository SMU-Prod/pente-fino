import type { InvoiceCanonical } from "@pentefino/core";
import {
  RN_020, RN_021, RN_021_CONFIRM, RN_023,
} from "./lexicon.js";

/**
 * Two fixture invoices per RN-020/021/023 — one a correct evaluator should
 * fire on, one it should not — same shape and same purpose as
 * `deterministic.fixtures.ts`. See that file's own doc comment for the
 * general contract; the notes below only cover what is specific to these
 * four rows.
 *
 * `RN_021_CONFIRM` is the one row where an invoice pair by itself cannot
 * express fire/not-fire: the `confirm` evaluator (`confirm.ts`) never reads
 * invoice content — its outcome depends entirely on `ctx.answers`. Its
 * `fires`/`clean` pair below still exists (so the generic "parses as a
 * valid InvoiceCanonical" / "meaningfully different" checks in
 * `lexicon.test.ts` have something to check), but this package cannot call
 * `confirm(...)` itself to prove fire/not-fire — `@pentefino/core`'s
 * package.json only exposes its top-level index and `./ports`, not a
 * `./rules/evaluators/*` subpath, so the evaluator function is not
 * reachable from `packages/db` at all. `lexicon.test.ts` instead asserts
 * the seeded spec's *shape* (its question is phrased so a "Não" answer
 * means the user disputes the charge, and `onNo` is `"create_finding"`) —
 * the evaluator's own fire/not-fire behaviour for that shape is already
 * covered by `confirm.test.ts` in `packages/core`.
 */

type Scenario = { invoice: InvoiceCanonical; previous: InvoiceCanonical | null };
export type FixturePair = { fires: Scenario; clean: Scenario };

function inv(partial: Omit<InvoiceCanonical, "extraction">): InvoiceCanonical {
  return { ...partial, extraction: { confidence: 0.92, warnings: [] } };
}

// --- RN-020 — telecom, SVA in an anchor section ----------------------------
//
// Fires on CLAUDE.md's own finding #1: Vivo's "Serviços Digitais III" is a
// *package* line that sums several separate SVA items into one billed
// amount — a rule keyed only on the sub-item names (Skeelo, FunKids, ...)
// would see one ordinary charge where there are really several stacked SVA
// items. Also includes a plain per-item hit ("Skeelo Premium") to prove the
// original item-level lexicon still works alongside the package-level one.
const rn020Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Vivo", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 12970,
    sections: [{
      name: "Serviços Digitais",
      items: [
        { description: "Plano Vivo Turbo 5G", amountCents: 9000 },
        { description: "Serviços Digitais III", amountCents: 2970 },
        { description: "Skeelo Premium", amountCents: 1000 },
      ],
    }],
  }),
  previous: null,
};

// Clean: same anchor section, no lexicon term anywhere in it.
const rn020Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Vivo", category: "telecom" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 9000,
    sections: [{
      name: "Serviços Digitais",
      items: [{ description: "Plano Vivo Turbo 5G", amountCents: 9000 }],
    }],
  }),
  previous: null,
};

// --- RN-021 (pattern half) — card, insurance lexicon + 1-cycle recurrence -
//
// Fires: "MP*Chubbsegurosbrasi" (CLAUDE.md §7.3's strongest single finding)
// present on both the current and the previous invoice — the 1-cycle proxy
// this seed uses for the PRD's "3+ ciclos".
const rn021PreviousWithChubb: InvoiceCanonical = inv({
  issuer: { name: "Banco Exemplo Cartão", category: "card" },
  period: { start: "2026-06-01", end: "2026-06-30" },
  dueDate: "2026-07-10",
  totalCents: 50799,
  sections: [{
    name: "Compras",
    items: [
      { description: "Compras do período", amountCents: 50000 },
      { description: "MP*Chubbsegurosbrasi", amountCents: 799 },
    ],
  }],
});

const rn021Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Banco Exemplo Cartão", category: "card" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 50799,
    sections: [{
      name: "Compras",
      items: [
        { description: "Compras do período", amountCents: 50000 },
        { description: "MP*Chubbsegurosbrasi", amountCents: 799 },
      ],
    }],
  }),
  previous: rn021PreviousWithChubb,
};

// Clean: the exact same insurance-lexicon line appears, but with no
// previous invoice at all — proves `requireRecurrence: 1` actually gates
// the match instead of firing on a single sighting.
const rn021Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Banco Exemplo Cartão", category: "card" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 50799,
    sections: [{
      name: "Compras",
      items: [
        { description: "Compras do período", amountCents: 50000 },
        { description: "MP*Chubbsegurosbrasi", amountCents: 799 },
      ],
    }],
  }),
  previous: null,
};

// --- RN-021 (confirm half) --------------------------------------------
//
// The `confirm` evaluator does not read invoice content at all (see the
// module doc comment) — this pair exists for schema/shape consistency, not
// as the fire/not-fire proof. The two invoices are still made to differ
// (a recurring, unmatched card fee vs. a single ordinary purchase) so they
// read as a believable "this is the shape RN-021's confirm question is
// meant for" example, even though the evaluator itself does not look at it.
const rn021ConfirmFires: Scenario = {
  invoice: inv({
    issuer: { name: "Banco Exemplo Cartão", category: "card" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 50599,
    sections: [{
      name: "Compras",
      items: [
        { description: "Compras do período", amountCents: 50000 },
        { description: "Proteção Mensal XPTO", amountCents: 599 },
      ],
    }],
  }),
  previous: null,
};

const rn021ConfirmClean: Scenario = {
  invoice: inv({
    issuer: { name: "Banco Exemplo Cartão", category: "card" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 50000,
    sections: [{
      name: "Compras",
      items: [{ description: "Compras do período", amountCents: 50000 }],
    }],
  }),
  previous: null,
};

// --- RN-023 — card, processor-prefix descriptor + 1-cycle recurrence ------
//
// Fires: "HTM*Curso Online Anual" (Hotmart's confirmed descriptor prefix)
// present on both invoices — same 1-cycle recurrence proxy as RN-021, here
// guarding against classifying a one-off purchase as a subscription.
const rn023PreviousWithHotmart: InvoiceCanonical = inv({
  issuer: { name: "Banco Exemplo Cartão", category: "card" },
  period: { start: "2026-06-01", end: "2026-06-30" },
  dueDate: "2026-07-10",
  totalCents: 54990,
  sections: [{
    name: "Compras",
    items: [
      { description: "Compras do período", amountCents: 50000 },
      { description: "HTM*Curso Online Anual", amountCents: 4990 },
    ],
  }],
});

const rn023Fires: Scenario = {
  invoice: inv({
    issuer: { name: "Banco Exemplo Cartão", category: "card" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 54990,
    sections: [{
      name: "Compras",
      items: [
        { description: "Compras do período", amountCents: 50000 },
        { description: "HTM*Curso Online Anual", amountCents: 4990 },
      ],
    }],
  }),
  previous: rn023PreviousWithHotmart,
};

// Clean: same descriptor, but a single sighting with no previous invoice —
// exactly the one-off-purchase case RN-023's own recurrence condition
// exists to exclude from "assinatura recorrente".
const rn023Clean: Scenario = {
  invoice: inv({
    issuer: { name: "Banco Exemplo Cartão", category: "card" },
    period: { start: "2026-07-01", end: "2026-07-31" },
    dueDate: "2026-08-10",
    totalCents: 54990,
    sections: [{
      name: "Compras",
      items: [
        { description: "Compras do período", amountCents: 50000 },
        { description: "HTM*Curso Online Anual", amountCents: 4990 },
      ],
    }],
  }),
  previous: null,
};

export const LEXICON_FIXTURES: Record<string, FixturePair> = {
  [RN_020]: { fires: rn020Fires, clean: rn020Clean },
  [RN_021]: { fires: rn021Fires, clean: rn021Clean },
  [RN_021_CONFIRM]: { fires: rn021ConfirmFires, clean: rn021ConfirmClean },
  [RN_023]: { fires: rn023Fires, clean: rn023Clean },
};
