import type { Playbook, Stage } from "../cases/playbook.js";
import type { Finding } from "../rules/finding.js";
import type { LegalRef } from "../rules/spec.js";

/**
 * A protocol number the person has already registered at an earlier stage
 * (`caseProtocols` in the schema, trimmed to what a generator needs to write
 * a sentence about it). `assembleContest` does not interpret these — it only
 * carries them forward so the prose generator (Task 2) can mention them.
 */
export type RecordedProtocol = {
  stage: Stage;
  protocolNumber: string;
  channel: string;
};

export type AssembleContestInput = {
  findings: Finding[];
  stage: Stage;
  playbook: Playbook;
  protocols?: RecordedProtocol[];
};

export type AssembledContest = {
  stage: Stage;
  legalRefs: LegalRef[];
  asks: string[];
  attachmentsChecklist: string[];
  mandatoryScriptItems: string[];
  protocols: RecordedProtocol[];
};

// RF-163: whatever else a stage's script ends up saying, the person must
// always come away from the call having asked for these two things. Fixed
// regardless of stage or playbook — unlike `asks` and `attachmentsChecklist`
// below, there is no per-stage table to derive them from.
export const MANDATORY_SCRIPT_ITEMS = [
  "Pedir o número de protocolo do atendimento",
  "Pedir a gravação da ligação",
] as const;

// RF-165's one deterministic baseline: whatever else a stage needs, the
// invoice itself is always part of the checklist.
const BASE_ATTACHMENT = "Fatura do período contestado";

/**
 * Folds a `LegalRef` down to a comparison key that treats whitespace runs
 * and letter case as insignificant, so "CDC" / "cdc" and "art.  42" /
 * "art. 42" collapse to the same reference instead of surviving dedup as
 * two. `effect` is included because it is part of what the citation means,
 * not incidental formatting — two entries that cite the same article for
 * different legal effects are not duplicates. `note` is deliberately
 * excluded: it is free-form annotation, not part of the citation's identity.
 */
function legalRefKey(ref: LegalRef): string {
  return [ref.law, ref.article, ref.effect]
    .map((part) => part.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}

/**
 * RF-161's engine. The only place `legalRefs` come from is the union of
 * `finding.legalBasis` across `findings`, in first-seen order.
 *
 * Deliberately never touches `playbook.stages[...].legalRefs` — the
 * playbook's own per-stage `legalRefs` field describes the legal bases a
 * *typical* case at that stage invokes (used elsewhere to decide things like
 * default deadlines), not what *this* case's findings actually established.
 * Reading it here would let a citation reach a document that no rule fired
 * for this user — the exact hallucination-by-another-name RF-161 exists to
 * rule out. If a finding did not carry it, it does not appear.
 */
function collectLegalRefs(findings: Finding[]): LegalRef[] {
  const seen = new Set<string>();
  const refs: LegalRef[] = [];
  for (const finding of findings) {
    for (const ref of finding.legalBasis) {
      const key = legalRefKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * RF-165. The invoice is always on the checklist; a stage that requires a
 * previous protocol (§20.2's `requiresPreviousProtocol`) also needs proof of
 * it and of the conversation that produced it — the acceptance's own
 * example, `consumidor_gov`, is simply the first stage in the reference
 * playbook where that flag is true, not a hardcoded special case.
 */
function buildAttachmentsChecklist(requiresPreviousProtocol: boolean): string[] {
  if (!requiresPreviousProtocol) return [BASE_ATTACHMENT];
  return [
    BASE_ATTACHMENT,
    "Protocolo anterior do atendimento",
    "Print (captura de tela) da conversa com o atendimento anterior",
  ];
}

/**
 * Everything about a contestation that is not prose (E4 Task 1). Given the
 * findings that fired, the stage the case is at, the issuer's playbook, and
 * any protocols already on record, this produces the structured input a
 * prose generator (Task 2) turns into text — including the parts, `legalRefs`
 * above all, that the generator receives ready-made and must not add to.
 *
 * Pure and synchronous: no I/O, no clock, no randomness. A stage absent from
 * `playbook.stages` (a playbook need not cover every `Stage`) degrades to
 * empty `asks` and the base attachment only, rather than throwing — an
 * incomplete playbook should not be the reason document assembly fails
 * outright.
 */
export function assembleContest(input: AssembleContestInput): AssembledContest {
  const stagePlaybook = input.playbook.stages.find((entry) => entry.stage === input.stage);

  return {
    stage: input.stage,
    legalRefs: collectLegalRefs(input.findings),
    asks: stagePlaybook ? [...stagePlaybook.asks] : [],
    attachmentsChecklist: buildAttachmentsChecklist(stagePlaybook?.requiresPreviousProtocol ?? false),
    mandatoryScriptItems: [...MANDATORY_SCRIPT_ITEMS],
    protocols: input.protocols ?? [],
  };
}
