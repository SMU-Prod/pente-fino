import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

/**
 * PRD §13.1's three faces, self-hosted through `next/font/google` so the
 * browser never makes a request to Google Fonts at all (no
 * render-blocking third-party round trip, no layout shift while the
 * request is in flight) - `packages/ui/src/tokens.css` already declares
 * `--font-display`/`--font-body`/`--font-mono` with these families as the
 * *name*, but nothing downloaded the actual font files, so every screen
 * silently fell back to Georgia/system-ui. `RootLayout` applies each
 * font's `.variable` className to `<html>`, which is what makes these
 * three custom properties resolve to the real, loaded typeface instead of
 * the fallback stack tokens.css also carries for any non-Next consumer of
 * that same file.
 *
 * `display: "swap"` on all three: RNF-03 caps LCP at 2,0s on 4G, and the
 * one thing worse than a fallback-font flash is text that stays invisible
 * until a slow font finishes downloading (`display: "block"`'s default
 * behavior). `swap` paints with the fallback immediately and swaps in the
 * real face when it lands.
 */

/**
 * The display face. §13.1 calls out `SOFT 20 / WONK 1` as this face's fixed
 * identity, not a user-adjustable range - `axes` only makes those two
 * variable axes exist in the self-hosted instance next/font downloads;
 * `tokens.css`'s `:root` is what pins the values to 20/1 via
 * `font-variation-settings`, inherited by every element that renders in
 * this face.
 *
 * `subsets: ["latin"]` is deliberate, not the default: Google's "latin"
 * subset already spans U+0000-00FF, which covers every accented letter
 * Brazilian Portuguese uses (ã, õ, ç, é, í, ó, ê, â, à...) - "latin-ext"
 * and every other subset this font ships (vietnamese) would be bytes
 * RNF-03/RNF-05's budget cannot spend on a script this app never renders.
 */
export const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK"],
  display: "swap",
  variable: "--font-display",
});

/**
 * The body face. Only the two weights the app's CSS actually sets - `400`
 * (body text, the browser default) and `600` (every heading/button in
 * `laudo.module.css`). Omitting `weight` would default to the full
 * variable `100..700` range: one file heavier than these two static
 * instances combined, covering five weights nothing in this app renders.
 */
export const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--font-body",
});

/**
 * The mono face - ledger rows, badges, protocol numbers, invoice figures.
 * IBM Plex Mono has no variable instance to default to (unlike the two
 * faces above, `weight` is mandatory here), and every `--font-mono` usage
 * in the app today renders at the regular weight, so `400` is the only one
 * requested.
 */
export const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  variable: "--font-mono",
});
