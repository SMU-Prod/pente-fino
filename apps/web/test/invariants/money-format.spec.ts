import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One money formatter for the whole product, and `apps/web` is not allowed
 * to own a second one.
 *
 * `packages/core/src/documents/dossier.ts` and `apps/jobs`'s PDF renderer
 * each grew a private `formatCentsBRL` and drifted apart unnoticed: the same
 * dossier page printed `R$ 1189,90` from one and `R$ 1.189,90` from the
 * other, `R$ -1,50` from one and `-R$ 1,50` from the other. E5 task 7
 * collapsed those two into `@pentefino/core`'s `formatCentsBRL`.
 *
 * `apps/web` carried three more copies of the same function - the card
 * route, the public `/l/[token]` loader and `lib/report.ts`. They had not
 * drifted yet; the point of this invariant is that they never get the
 * chance. A value test can only pin the copies it knows to import, so it
 * cannot notice a fourth one appearing next to a new surface - this reads
 * the source instead, and fails on the declaration itself.
 */
const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Everything under `apps/web` that renders or serves a money value. */
const SCANNED_DIRS = ["app", "lib"];

/** `function formatCentsBRL(`, `const formatMoney =`, and anything shaped like them. */
const FORMATTER_DECLARATION = /(?:function|const|let)\s+format[A-Za-z]*(?:Cents|BRL|Money)[A-Za-z]*\s*[=(]/;

/**
 * A template literal assembling a currency string out of its own parts -
 * `` `${sign}R$ ${reais},${centavos}` ``. Catches a re-implementation that
 * avoids the naming convention above. A plain `R$ 25,45` in a comment or a
 * pt-BR copy string has no interpolation and does not match.
 */
const CURRENCY_TEMPLATE = /R\$ \$\{/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Repo-relative paths, so a failure names the offending file readably. */
function offenders(pattern: RegExp): string[] {
  return SCANNED_DIRS
    .flatMap((dir) => sourceFiles(join(WEB_ROOT, dir)))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(WEB_ROOT.length).replaceAll("\\", "/"))
    .sort();
}

describe("apps/web has exactly one money formatter, and it is core's", () => {
  it("declares no money formatter of its own", () => {
    expect(offenders(FORMATTER_DECLARATION)).toEqual([]);
  });

  it("assembles no currency string out of its own parts", () => {
    expect(offenders(CURRENCY_TEMPLATE)).toEqual([]);
  });

  it("scans the files it means to - the guard is worthless if it reads nothing", () => {
    const scanned = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(WEB_ROOT, dir)));
    expect(scanned.length).toBeGreaterThan(20);
  });
});
