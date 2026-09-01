import { describe, expect, it } from "vitest";
import { lintUserFacingText } from "@pentefino/ai";
import * as copy from "../../app/l/[token]/copy.js";

/**
 * Every string RF-146's public `/l/[token]` page (and its `not-found.tsx`)
 * can render - this is the product's first surface reachable with no
 * session at all, so every word here reaches a stranger before they have
 * any other reason to trust this product.
 */
function allStrings(): string[] {
  return [
    copy.BRAND,
    copy.EYEBROW,
    copy.totalToVerifyLine("R$ 25,45"),
    copy.doubledLine("R$ 50,90"),
    copy.findingsLine(1),
    copy.findingsLine(3),
    copy.TOTAL_TO_VERIFY_LABEL,
    copy.TOTAL_DOUBLED_LABEL,
    copy.CLEAN_REPORT_MESSAGE,
    copy.CTA_HEADING,
    copy.CTA_BODY,
    copy.CTA_BUTTON,
    copy.NOT_FOUND_MESSAGE,
    copy.BACK_HOME,
  ];
}

describe("public /l/[token] page copy (§14.2/§14.3, INV-004)", () => {
  it("every string this page can render passes lintUserFacingText", () => {
    for (const text of allStrings()) {
      const result = lintUserFacingText(text);
      expect(result.ok, `"${text}" violated: ${JSON.stringify(result.violations)}`).toBe(true);
    }
  });

  it("says 'para você verificar', never 'de cobrança ilegal' (§14.2)", () => {
    const line = copy.totalToVerifyLine("R$ 25,45");
    expect(line).toBe("Encontramos R$ 25,45 para você verificar.");
    expect(lintUserFacingText(line).ok).toBe(true);
  });

  it("says 'a norma prevê devolução em dobro', never 'você tem direito a receber' (§14.2)", () => {
    const line = copy.doubledLine("R$ 50,90");
    expect(line).toMatch(/^A norma prevê devolução em dobro/);
    expect(line).not.toMatch(/direito a receber/);
  });

  it("pluralizes the findings line correctly", () => {
    expect(copy.findingsLine(1)).toBe("1 cobrança para revisar");
    expect(copy.findingsLine(2)).toBe("2 cobranças para revisar");
  });

  it("never claims a charge is illegal in the not-found or CTA copy", () => {
    for (const text of [copy.NOT_FOUND_MESSAGE, copy.CTA_HEADING, copy.CTA_BODY]) {
      expect(text.toLowerCase()).not.toContain("ilegal");
    }
  });
});
