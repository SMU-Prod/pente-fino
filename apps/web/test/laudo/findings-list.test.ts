import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FindingsList } from "../../app/laudo/[id]/FindingsList.js";
import type { PendingQuestion, ReportItem } from "../../app/laudo/[id]/report-items.js";

/**
 * A static-markup smoke test for the one client component this screen has.
 * `renderToStaticMarkup` exercises its initial render (including `useState`
 * initial values) without a DOM - the interactive behaviour itself (what
 * happens after a click) is covered by the pure `report-items.test.ts` and
 * `feedback-client.test.ts`, which this component is built out of.
 *
 * `FindingsList` uses hooks, so it must be rendered through
 * `createElement`/`renderToStaticMarkup`, not called as a plain function -
 * React's hook dispatcher is only set up during an actual render pass. (The
 * page-level test can call `LaudoPage(...)` directly because that
 * component, an async Server Component, holds no hooks of its own.)
 */
function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element);
}
function verifyFinding(): ReportItem {
  return {
    id: "fnd_verify",
    invoiceId: "inv_1",
    itemId: null,
    ruleId: "rul_1",
    ruleVersion: 1,
    confidence: 0.7,
    evidence: ["Cobrança repetida no mesmo ciclo."],
    amountCents: 1500,
    doubledCents: null,
    shadow: false,
    status: "open",
    createdAt: new Date(),
    updatedAt: new Date(),
    band: "verify",
  } as ReportItem;
}

function pendingQuestion(): PendingQuestion {
  return {
    id: "fnd_question",
    invoiceId: "inv_1",
    itemId: null,
    ruleId: "rul_2",
    ruleVersion: 1,
    confidence: 0.4,
    evidence: ["Assinatura não reconhecida no histórico."],
    amountCents: 0,
    doubledCents: null,
    shadow: false,
    status: "open",
    createdAt: new Date(),
    updatedAt: new Date(),
    band: "question",
    askUser: { question: "Você reconhece esta assinatura?", options: ["Sim", "Não"] },
  } as PendingQuestion;
}

describe("FindingsList initial render", () => {
  it("renders a regular finding with its evidence, confidence label and dismiss button", () => {
    const html = render(
      createElement(FindingsList, { initialFindings: [verifyFinding()], initialQuestions: [] }),
    );
    expect(html).toContain("Cobrança repetida no mesmo ciclo.");
    expect(html).toContain("Verificar");
    expect(html).toContain("Isso eu contratei");
    expect(html).toContain("R$ 15,00");
  });

  it("renders a pending question with its options, in its own section", () => {
    const html = render(
      createElement(FindingsList, { initialFindings: [], initialQuestions: [pendingQuestion()] }),
    );
    expect(html).toContain("Perguntas pendentes");
    expect(html).toContain("Você reconhece esta assinatura?");
    expect(html).toContain(">Sim<");
    expect(html).toContain(">Não<");
    expect(html).not.toContain("Isso eu contratei");
  });

  it("never shows a dismiss button on an aggregate row (its id is not a real finding)", () => {
    const aggregate: ReportItem = {
      id: "agg:Serviços digitais",
      aggregate: true,
      itemId: null,
      confidence: 0.9,
      band: "likely",
      evidence: ["R$ 51,60 em 5 serviços digitais"],
      amountCents: 5160,
      doubledCents: null,
    } as ReportItem;

    const html = render(createElement(FindingsList, { initialFindings: [aggregate], initialQuestions: [] }));
    expect(html).toContain("R$ 51,60 em 5 serviços digitais");
    expect(html).not.toContain("Isso eu contratei");
  });

  it("renders nothing (no stray sections) when there is nothing to show", () => {
    const html = render(createElement(FindingsList, { initialFindings: [], initialQuestions: [] }));
    expect(html).not.toContain("Achados");
    expect(html).not.toContain("Perguntas pendentes");
  });
});
