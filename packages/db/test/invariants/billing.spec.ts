import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../src/schema.js";

// English and Portuguese vocabulary for "a cut of what the user recovers".
// `percent`/`percentual` also catches "percentage"/"percentagem" as a
// prefix. `taxa[ _]?de[ _]?exito` accepts the term written as one
// snake_case identifier (`taxa_de_exito`), as a spaced phrase
// ("taxa de êxito", once accents are stripped — see `stripAccents` below),
// or run together with no separator at all (a camelCase field would
// normalise to `taxadeexito`).
const BANNED_TERMS =
  "commission|success_?fee|percent|comissao|percentual|taxa[ _]?de[ _]?exito";

// Anchored to the start: a column or identifier *named* one of these things
// is banned, regardless of what follows (`commissionPercent`,
// `successFeeCents`, `percentualDevido`). `percent` belongs here because
// PRD §3 names it verbatim: a billing column called `percent_something` is
// the shape this inviolable forbids.
const BANNED = new RegExp(`^(${BANNED_TERMS})`, "i");

// The free-text scan is deliberately NARROWER than the column-name check,
// and this is the interesting part of the file.
//
// `percent` is ordinary vocabulary. A rules evaluator explaining that its
// tolerance is "a percentage of the expected value" has nothing to do with
// taking a cut of what a user recovers, and the first version of this check
// flagged exactly that — a comment in `rules/evaluators/arithmetic.ts` about
// tolerance arithmetic — turning an inviolable into noise a developer learns
// to route around. An invariant that cries wolf stops being enforcement.
//
// So the text scan looks only for the commission *concept*, in both
// languages. The column-name check above still carries the full list,
// because there `percent` is a name and not a sentence.
const COMMISSION_CONCEPT =
  "commission|success_?fee|comissao|taxa[ _]?de[ _]?exito";
const BANNED_IN_TEXT = new RegExp(`\\b(${COMMISSION_CONCEPT})`, "i");

// Unicode "Combining Diacritical Marks" block: NFD decomposition splits an
// accented letter like "ã" or "ê" into a plain letter followed by one of
// these combining marks. Named as code points (rather than written as a
// regex escape) to keep the exact characters unambiguous in source control.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;

/** Strips diacritics so `comissão` and `êxito` match their unaccented forms. */
function stripAccents(text: string): string {
  return Array.from(text.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code < COMBINING_MARKS_START || code > COMBINING_MARKS_END;
    })
    .join("");
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** Every tracked TypeScript source file under `packages/core`, repo-root-anchored. */
function coreSourceFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "packages/core"], { encoding: "utf8" });
  return out.split("\n").filter((file) => file.endsWith(".ts"));
}

describe("INV-001 · never charge a percentage of what the user recovers", () => {
  it("has no commission-shaped column anywhere in the schema", () => {
    const offenders: string[] = [];
    for (const [name, table] of Object.entries(schema)) {
      if (typeof table !== "object" || table === null) continue;
      let columns: Record<string, { name: string }>;
      try { columns = getTableColumns(table as never); } catch { continue; }
      for (const column of Object.values(columns)) {
        if (BANNED.test(stripAccents(column.name))) offenders.push(`${name}.${column.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The billing shape most of this product carries is not SQL columns —
  // it's `RuleSpec`, `Playbook`, `ContestDocument` and `InvoiceCanonical`,
  // all typed in `@pentefino/core` and stored as `jsonb`. A `commissionPercent`
  // field inside one of those is invisible to `getTableColumns` above: the
  // database only ever sees an opaque `jsonb` column, never the field names
  // inside it. This check reads `packages/core`'s own TypeScript sources
  // instead, so a commission concept cannot enter the product through a
  // jsonb payload either.
  it("has no commission-shaped field anywhere in @pentefino/core's TypeScript sources", () => {
    const root = repoRoot();
    const offenders: string[] = [];
    for (const file of coreSourceFiles(root)) {
      const text = stripAccents(readFileSync(join(root, file), "utf8"));
      for (const [index, line] of text.split("\n").entries()) {
        if (BANNED_IN_TEXT.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
