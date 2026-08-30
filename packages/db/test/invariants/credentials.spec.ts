import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const AUTH_CONTEXT = /(password|senha|credential|login|signin|sign_in|token)/i;

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
        if (line.includes("gov.br") && AUTH_CONTEXT.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
