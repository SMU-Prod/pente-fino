import type { LegalRef } from "../rules/spec.js";

export const STAGES = [
  "draft", "sac", "ombudsman", "consumidor_gov",
  "regulator", "procon", "jec_ready", "closed",
] as const;
export type Stage = (typeof STAGES)[number];

export type Playbook = {
  stages: Array<{
    stage: Stage;
    channel: string;
    deepLink?: string;
    responseDays: number;
    businessDays: boolean;
    requiresPreviousProtocol: boolean;
    asks: string[];
    legalRefs: LegalRef[];
  }>;
  notes?: string;
};
