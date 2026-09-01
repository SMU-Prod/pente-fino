import { nanoid } from "nanoid";

/**
 * Semantic prefixes, one per table that owns identified rows (PRD §6.1),
 * plus "run" for queue run ids (packages/adapters' in-process queue), which
 * do not back a table but still want a minted id rather than borrowing
 * another prefix's id space.
 */
export type IdPrefix =
  | "usr" | "ses" | "iss" | "inv" | "itm" | "rul" | "fnd" | "cas"
  | "doc" | "prt" | "evt" | "aic" | "prm" | "tar" | "flg" | "agg"
  | "ent" | "seo" | "rmt" | "prp" | "run";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nanoid(21)}`;
}

/**
 * A bearer capability token for a session-less, public route (RF-145's
 * shareable card; RF-146's `/l/[token]` laudo page reuses the same column
 * and this same generator rather than minting a second secret for what is
 * the same access-control question - "does whoever holds this string get to
 * see this invoice's public view").
 *
 * Deliberately not a `newId(...)`: an invoice's `id` is a `newId("inv")`
 * value, and that same id already appears throughout the app wherever the
 * invoice is referenced at all - authenticated routes, logs, events, error
 * payloads. None of those call sites treat it as secret, because until now
 * nothing needed it to be. Reusing it as the credential for a public,
 * unauthenticated route would make every one of those ordinary, low-stakes
 * appearances into a public-card leak. A public token is instead its own
 * value, generated only when something is deliberately made shareable, with
 * no semantic prefix (so it can never be mistaken for, or grepped alongside,
 * any table's id namespace) and a longer body than `newId`'s 21 characters,
 * since it is meant to stand alone as the only thing gating access.
 */
export function newPublicToken(): string {
  return nanoid(32);
}
