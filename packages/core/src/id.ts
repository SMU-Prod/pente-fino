import { nanoid } from "nanoid";

/** Semantic prefixes, one per table that owns identified rows (PRD §6.1). */
export type IdPrefix =
  | "usr" | "ses" | "iss" | "inv" | "itm" | "rul" | "fnd" | "cas"
  | "doc" | "prt" | "evt" | "aic" | "prm" | "tar" | "flg" | "agg"
  | "ent" | "seo" | "rmt" | "prp";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nanoid(21)}`;
}
