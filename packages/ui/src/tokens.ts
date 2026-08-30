/**
 * PRD §13.1. Every token exists in both themes.
 *
 * §13.1 gives dark-theme values for only five tokens: paper, card, ink,
 * mark and ok. The other five tokens that vary by theme — ink2, ink3,
 * line, markSoft and okSoft — have no dark value in the PRD; the dark
 * values below for those five are inferred (chosen to hold roughly the
 * same contrast relationships as their light counterparts), not a
 * transcription of a PRD-specified number. Treat them as a starting
 * point for the first real screen to correct, not as spec.
 *
 * `deep` is not part of that inference: the PRD lists a single value
 * for it with no "Escuro" override, so it is treated as theme-invariant
 * and kept identical in both palettes below.
 */
export const TOKENS = {
  light: {
    paper: "#FBF8F3", card: "#FFFFFF", ink: "#191411",
    ink2: "#54483F", ink3: "#8A7C71", line: "#E4DCD1",
    mark: "#C0432A", markSoft: "#FAEAE5",
    ok: "#1F6B4F", okSoft: "#E3F0E9",
    deep: "#1E2A2E",
  },
  dark: {
    paper: "#14100E", card: "#1D1815", ink: "#F3EEE7",
    ink2: "#C3B8AC", ink3: "#8A7C71", line: "#2E2721",
    mark: "#F0836A", markSoft: "#3A211B",
    ok: "#7ECBA4", okSoft: "#1B2E25",
    deep: "#1E2A2E",
  },
  fonts: {
    display: '"Fraunces", Georgia, serif',
    body: '"IBM Plex Sans", system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
  },
} as const;
