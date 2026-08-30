import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// English and Portuguese authentication/credential vocabulary. `credencial`
// is listed separately from `credential`: the Portuguese word has a `c`
// where English has a `t` (crede-N-C-ial vs crede-N-T-ial), so neither
// string is a substring of the other and the English form alone would never
// catch it. `autentic` is a stem, not one fixed word: it is the common
// prefix of every inflected form a Brazilian Portuguese sentence about
// authentication is likely to use — autenticação/autenticacao (noun),
// autenticando (gerund), autenticar (infinitive), autenticado (participle)
// — all of which describe a live authentication flow as much as the noun
// alone would.
const AUTH_CONTEXT =
  /(password|senha|credential|credencial|login|logar|logando|signin|sign_in|token|autentic|acesso|cadastro)/i;

// Unicode "Combining Diacritical Marks" block: NFD decomposition splits an
// accented letter like "ã" or "ê" into a plain letter followed by one of
// these combining marks. Named as code points (rather than written as a
// regex escape) to keep the exact characters unambiguous in source control.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;

/** Strips diacritics so e.g. `autenticação` still matches the unaccented `autentic` stem. */
function stripAccents(text: string): string {
  return Array.from(text.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code < COMBINING_MARKS_START || code > COMBINING_MARKS_END;
    })
    .join("");
}

// `execFileSync` with an argv array, never a shell string: on Windows,
// `execSync`'s default shell is cmd.exe, which does not strip single quotes
// the way POSIX `/bin/sh` does. A string command like
// `git ls-files '*.ts' '*.tsx' '*.js'` reaches git with the quote characters
// still attached, matches nothing, and this check would pass on every run
// for the wrong reason — not because the repository is clean, but because
// it never looked. Bypassing the shell entirely sidesteps that on every
// platform.
//
// The repo root, not `process.cwd()`, anchors both the listing and the
// reads: vitest runs this file from `packages/db`, and `git ls-files` scopes
// itself to the current directory, so an unqualified call here would only
// ever see `packages/db` — silently missing every other package.
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function trackedSourceFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "*.ts", "*.tsx", "*.js"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

describe("INV-002 · never handle a third party credential", () => {
  it("never mentions gov.br near authentication vocabulary", () => {
    const root = repoRoot();
    const offenders: string[] = [];
    for (const file of trackedSourceFiles(root)) {
      const text = readFileSync(join(root, file), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (line.includes("gov.br") && AUTH_CONTEXT.test(stripAccents(line))) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
