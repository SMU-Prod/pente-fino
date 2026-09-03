import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * RF-245's acceptance ("sem consentimento, a fatura não alimenta
 * `aggregates`") has nothing real to test yet — nothing in this repo writes
 * `aggregates` today; that pipeline arrives with E10/E11. So the whole
 * requirement, right now, is about making it *impossible to get wrong
 * later*, not about filtering a job that exists.
 *
 * `apps/web/test/routes/cron.test.ts` establishes the precedent this test
 * follows: reading the repository's own source is sometimes the only way to
 * ask a question the runtime cannot answer, because there is no live thing
 * to interrogate. That test reads `container.ts` to catch a handler
 * registered but never scheduled — "capable, not live" — which is exactly
 * the state every job in this repo sat in before its scheduler entry
 * existed. `invoicesEligibleForAggregation` (`aggregation.ts`) is a bare
 * eligibility function nobody is yet obliged to call, which is the same
 * state one step earlier: nothing stops a future writer from reaching past
 * it and inserting into `aggregates` straight from wherever is convenient,
 * silently reopening RF-245 the day someone builds the pipeline this task
 * is preparing for.
 *
 * This guard is what makes the obligation real ahead of time: it scans
 * every application and package source tree and fails the build the moment
 * any module other than the two allowed below targets the `aggregates`
 * table, so the constraint is enforced from the day it is written, not from
 * the day someone remembers to check.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The only files allowed to target the `aggregates` table. Kept as an
// explicit named constant, not folded into the regex or the scan logic, so
// that the day a real aggregation writer is built, extending this list is a
// visible, reviewable, one-line change — not a weakening of the pattern
// that catches everything else.
const AGGREGATES_WRITE_ALLOWLIST = new Set([
  "packages/db/src/aggregation.ts", // the eligibility gate this task adds
  "packages/db/src/schema.ts", // the table's own definition
]);

// The four shapes a write (or a read that could become one) to `aggregates`
// takes, per the brief: an insert, an update, a reach through the `schema`
// namespace, or a named import of the table itself.
const AGGREGATES_REFERENCE_PATTERNS: RegExp[] = [
  /\binsert\(\s*aggregates\b/,
  /\bupdate\(\s*aggregates\b/,
  /\bschema\.aggregates\b/,
  /\bimport\s*\{[^}]*\baggregates\b[^}]*\}\s*from/,
];

// Only the source trees a real app or package ships from. `dist`/`.next`
// are build output (this same source, already scanned once as source); a
// `node_modules` nested inside a package would be a third party's code, not
// ours; and a test file's whole job is to exercise `aggregates` through
// `aggregation.ts`'s own tests, or to *simulate* a violation the way this
// guard's own self-test below does, so it is deliberately not in scope for
// what counts as a real writer.
const SOURCE_SUBDIRS = ["src", "app", "lib"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".next", "test", "tests"]);
const TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const SOURCE_FILE_NAME = /\.[cm]?[jt]sx?$/i;

function isTestFile(name: string): boolean {
  return TEST_FILE_NAME.test(name);
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_FILE_NAME.test(entry) && !isTestFile(entry)) {
      out.push(full);
    }
  }
}

/** Every source file under `apps/*` and `packages/*`'s `src`/`app`/`lib` trees. */
function allSourceFiles(): string[] {
  const files: string[] = [];
  for (const scanRoot of ["apps", "packages"]) {
    const rootDir = join(REPO_ROOT, scanRoot);
    for (const workspaceName of readdirSync(rootDir)) {
      const workspaceDir = join(rootDir, workspaceName);
      if (!statSync(workspaceDir).isDirectory()) continue;
      for (const sourceSubdir of SOURCE_SUBDIRS) {
        const dir = join(workspaceDir, sourceSubdir);
        try {
          if (statSync(dir).isDirectory()) walk(dir, files);
        } catch {
          // No such subdirectory in this workspace (e.g. packages/config has
          // no src/) — nothing to scan there.
        }
      }
    }
  }
  return files;
}

function toRepoRelativePath(absolutePath: string): string {
  return absolutePath.slice(REPO_ROOT.length).replace(/\\/g, "/");
}

describe("aggregates drift guard (RF-245)", () => {
  it("finds source files to scan, so a passing run means something", () => {
    // If this ever comes back empty, the scan roots are wrong and every
    // other assertion below is vacuously true — exactly the silent-pass
    // failure mode `cron.test.ts`'s own drift guard guards against.
    expect(allSourceFiles().length).toBeGreaterThan(0);
  });

  it("lets no module outside the allowlist target the `aggregates` table", () => {
    const offenders: string[] = [];
    for (const absolutePath of allSourceFiles()) {
      const relativePath = toRepoRelativePath(absolutePath);
      if (AGGREGATES_WRITE_ALLOWLIST.has(relativePath)) continue;
      const content = readFileSync(absolutePath, "utf8");
      if (AGGREGATES_REFERENCE_PATTERNS.some((pattern) => pattern.test(content))) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The patterns above have no live positive to match against yet — nothing
  // in this repo writes `aggregates` today, which is the whole point of
  // this guard. Without this, the two tests above could both pass forever
  // because the regexes silently stopped matching anything at all, and
  // nobody would notice until the day they were actually needed. Testing
  // the patterns directly against synthetic snippets is the permanent
  // substitute for a manual "break it and watch it fail" check that cannot
  // otherwise live in the suite.
  describe("the patterns this guard looks for", () => {
    it.each([
      ["db.insert(aggregates).values({ id })", true],
      ["await tx.update(aggregates).set({ flagged: 1 })", true],
      ["schema.aggregates", true],
      ['import { aggregates } from "../schema.js";', true],
      ['import { aggregates, issuers } from "./schema.js";', true],
      // False-positive guards: none of these mention the table at all.
      ["const aggregates = computeSomethingElse(items);", false],
      ["db.insert(invoices).values({ id })", false],
      ["schema.invoices", false],
    ])("recognizes %s as a match: %s", (snippet, shouldMatch) => {
      const matched = AGGREGATES_REFERENCE_PATTERNS.some((pattern) => pattern.test(snippet));
      expect(matched).toBe(shouldMatch);
    });
  });
});
