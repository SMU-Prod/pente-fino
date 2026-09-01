import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { lintUserFacingText } from "@pentefino/ai";
import PublicLaudoNotFound from "../../app/l/[token]/not-found.js";

/**
 * RF-146's segment-level `not-found.tsx`: what a stranger actually sees
 * when `page.tsx` calls `notFound()` for a missing, revoked, or
 * not-yet-analyzed token - §13.3's "every empty state is written" applies
 * even to the one state on this route that is, by construction, an HTTP
 * 404.
 */
describe("/l/[token] not-found boundary", () => {
  it("shows the written message, never a blank page", () => {
    const html = renderToStaticMarkup(PublicLaudoNotFound());
    expect(html).toContain("Este laudo não está mais disponível.");
  });

  it("offers a way back to the product", () => {
    const html = renderToStaticMarkup(PublicLaudoNotFound());
    expect(html).toMatch(/href="\/"[^>]*>Voltar para o início/);
  });

  it("passes lintUserFacingText", () => {
    const html = renderToStaticMarkup(PublicLaudoNotFound());
    expect(lintUserFacingText(html)).toMatchObject({ ok: true });
  });
});
