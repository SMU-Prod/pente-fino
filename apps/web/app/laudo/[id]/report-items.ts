import type { ReportAggregate, ReportBand, ReportFinding } from "@/lib/report.js";
import { CONFIDENCE_LABEL } from "./copy.js";

export type ReportItem = ReportFinding | ReportAggregate;
export type PendingQuestion = ReportFinding & { band: "question" };

/**
 * A pending question is a real finding (never an aggregate - its id is a
 * synthetic `agg:<section>` that does not correspond to a feedback-able row,
 * see `buildAggregates` in `@/lib/report.js`) banded below RF-124's 0,55
 * threshold. The engine's own RF-124 rule is that anything under 0,55 is
 * created as a `confirm`-kind rule in the first place, so `askUser` should
 * always be present alongside this band - the UI still falls back
 * gracefully (see `copy.FALLBACK_QUESTION`) if it is ever not.
 */
export function isPendingQuestion(item: ReportItem): item is PendingQuestion {
  const isAggregate = "aggregate" in item && item.aggregate === true;
  return !isAggregate && item.band === "question";
}

export function splitReportItems(items: ReportItem[]): {
  regular: ReportItem[];
  questions: PendingQuestion[];
} {
  const regular: ReportItem[] = [];
  const questions: PendingQuestion[] = [];
  for (const item of items) {
    if (isPendingQuestion(item)) questions.push(item);
    else regular.push(item);
  }
  return { regular, questions };
}

export function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

/**
 * §13.3: confidence always in plain words, never a raw number. Returns
 * `null` for the "question" band on purpose - that band is rendered as a
 * question (see `isPendingQuestion`/`splitReportItems`), not a confidence
 * badge, so a caller that still holds a question-band item here (an
 * aggregate, per the guard above) simply shows no badge rather than an
 * invented one.
 */
export function confidenceLabel(band: ReportBand): string | null {
  if (band === "verify") return CONFIDENCE_LABEL.verify;
  if (band === "likely") return CONFIDENCE_LABEL.likely;
  return null;
}
