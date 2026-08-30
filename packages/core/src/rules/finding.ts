import type { LegalRef } from "./spec.js";

export type Finding = {
  ruleSlug: string;
  ruleVersion: number;
  itemId: string | null;
  amountCents: number;
  doubledCents: number | null;
  confidence: number;
  evidence: string[];
  legalBasis: LegalRef[];
  askUser?: { question: string; options: string[] };
  shadow: boolean;
};
