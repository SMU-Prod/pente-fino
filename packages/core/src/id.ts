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
