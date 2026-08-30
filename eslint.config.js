import tsParser from "@typescript-eslint/parser";
import { pentefino } from "@pentefino/config/eslint";

export default [
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**", ".data/**"] },
  // ESLint's flat config only recognizes `.js`/`.mjs`/`.cjs` by default. The
  // repo is almost entirely TypeScript, and the default parser (espree)
  // cannot read TS syntax at all, so both the file extensions and a
  // TS-capable parser have to be declared explicitly or `eslint .` matches
  // zero files. INV-008 is a purely syntactic AST check (import/export
  // specifiers), so the parser alone is enough — no type-checked project
  // config needed.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { parser: tsParser },
  },
  pentefino,
];
