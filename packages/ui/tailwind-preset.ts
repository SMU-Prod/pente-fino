/**
 * Tailwind is not a dependency anywhere in this monorepo yet, and the
 * only thing this file needs from the `tailwindcss` package is the shape
 * of its `Config` type. Adding the whole package as a devDependency just
 * to import one type would be disproportionate at this stage, so the
 * slice of `Config` actually used here is typed structurally instead.
 * This is a real `tailwindcss` v3/v4 `Partial<Config>` value at runtime —
 * consumers that do have `tailwindcss` installed can pass it straight to
 * their `tailwind.config` `presets` array.
 */
interface TailwindPresetConfig {
  theme?: {
    extend?: {
      colors?: Record<string, string>;
      fontFamily?: Record<string, string[]>;
    };
  };
}

/** PRD §13.1 tokens, exposed as Tailwind theme extensions bound to the CSS custom properties in tokens.css. */
export const preset: TailwindPresetConfig = {
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)", card: "var(--card)", ink: "var(--ink)",
        "ink-2": "var(--ink-2)", "ink-3": "var(--ink-3)", line: "var(--line)",
        mark: "var(--mark)", "mark-soft": "var(--mark-soft)",
        ok: "var(--ok)", "ok-soft": "var(--ok-soft)", deep: "var(--deep)",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
};

export default preset;
