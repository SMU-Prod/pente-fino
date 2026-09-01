import "./globals.css";
import { fraunces, ibmPlexMono, ibmPlexSans } from "./fonts.js";

export const metadata = { title: "Pente-fino", description: "Auditor de fatura" };

/**
 * PRD §13.1: each font's `.variable` className defines its `--font-*`
 * custom property (see `./fonts.ts`) - applying all three to `<html>` is
 * what makes `tokens.css`'s `--font-display`/`--font-body`/`--font-mono`
 * resolve to the real, self-hosted faces everywhere in the app, since every
 * element inherits from the root.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${fraunces.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
