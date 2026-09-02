import type { Playbook, Stage } from "../cases/playbook.js";
import type { Finding } from "../rules/finding.js";
import type { LegalRef } from "../rules/spec.js";
import { toCivilDate } from "../cases/deadline.js";
import { formatIsoDate } from "../format.js";

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

/**
 * RF-182's `deadlinesExpired`: one channel that was written to, was given a
 * deadline, and let it pass. E5 Task 5 defines the shape; E4's
 * `ContestPromptInput` deliberately left the field out rather than guess it.
 *
 * Every field is a **recorded fact**, never a recomputation:
 *
 *  - `channel`, `protocolNumber` and `registeredAt` are the `case_protocols`
 *    row the person filled in at `POST /api/cases/:id/protocol`.
 *  - `expiredAt` is that same row's `responseDueAt` — the instant Task 1's
 *    calculator produced *once*, when the protocol was registered, and which
 *    has been stored ever since. It is not re-derived here from the playbook
 *    and a clock: a document that recomputed the date would print whatever
 *    today's playbook says, not the deadline the company actually had.
 *  - That the deadline expired at all is read from a `deadline_expired`
 *    event (`collectExpiredDeadlines` below). That event is what Task 3's
 *    sweeper writes, and it is the only thing that makes the expiry a fact
 *    rather than an arithmetic opinion about the current time.
 */
export type ExpiredDeadline = {
  stage: Stage;
  channel: string;
  protocolNumber: string;
  /** When the person registered the protocol with the channel. */
  registeredAt: Date;
  /** The instant the channel's deadline to answer had passed. */
  expiredAt: Date;
};

export type AssembleContestInput = {
  findings: Finding[];
  stage: Stage;
  playbook: Playbook;
  protocols?: RecordedProtocol[];
  /** RF-182. Empty (or absent) whenever the case is not escalating on an expiry. */
  deadlinesExpired?: ExpiredDeadline[];
};

export type AssembledContest = {
  stage: Stage;
  legalRefs: LegalRef[];
  asks: string[];
  attachmentsChecklist: string[];
  mandatoryScriptItems: string[];
  protocols: RecordedProtocol[];
  /** RF-182's structured input, carried to the generator untouched. */
  deadlinesExpired: ExpiredDeadline[];
  /**
   * RF-182's acceptance, already written: one finished pt-BR sentence per
   * entry of `deadlinesExpired`, each naming the channel, the protocol
   * number and both dates. `packages/ai/src/contest.ts` attaches these to
   * `ContestDocument.escalationHistory` verbatim, exactly as it attaches
   * `legalRefs`, `asks` and `attachmentsChecklist` — the model is never
   * asked to reproduce them, so it cannot lose or garble them.
   */
  escalationHistory: string[];
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
 * A São Paulo civil date, as `dd/MM/yyyy`.
 *
 * `toCivilDate` rather than `formatUtcDate`, and this is the whole reason
 * this helper exists instead of a call to the formatter every other document
 * uses. `deadline.ts`'s third decision spells the bug out: a deadline
 * instant read back through UTC calendar components is a day early for
 * every case whose deadline instant falls after 21:00 local — and
 * `expiresAt` is *defined* as the last millisecond of the deadline day in
 * São Paulo, i.e. 02:59:59.999 UTC the following morning, so **every single**
 * `expiredAt` would print one day late through `formatUtcDate`. The
 * one date this document exists to state would be wrong on every document,
 * and wrong in the direction that hands the company a defence about our
 * arithmetic.
 */
function formatSaoPauloDate(instant: Date): string {
  return formatIsoDate(toCivilDate(instant));
}

/**
 * RF-182's sentence: "o texto sai com canal, protocolo e datas".
 *
 * Deterministic and complete, so RF-182's acceptance ("documento contém a
 * frase com número de protocolo e as duas datas") is true by construction
 * rather than by a model having remembered to write it.
 *
 * Written in the person's own voice about their own case (INV-003): it
 * states what happened to a protocol *they* registered. It deliberately says
 * "sem resposta dentro do prazo" rather than "sem resposta", because that is
 * the claim the `deadline_expired` event actually supports — a reply that
 * arrived *after* the deadline still leaves the sentence true, where a flat
 * "nobody answered" would become a false statement on the one document a
 * company is most likely to read carefully.
 */
export function expiredDeadlineSentence(deadline: ExpiredDeadline): string {
  return `Protocolo ${deadline.protocolNumber}, registrado no canal ${deadline.channel} em ` +
    `${formatSaoPauloDate(deadline.registeredAt)}: o prazo de resposta terminou em ` +
    `${formatSaoPauloDate(deadline.expiredAt)} sem resposta dentro do prazo.`;
}

/** The `case_protocols` columns RF-182's sentence needs. */
export type CaseProtocolRecord = {
  stage: Stage;
  protocolNumber: string;
  channel: string;
  registeredAt: Date;
  responseDueAt: Date;
};

/** The `events` columns `collectExpiredDeadlines` reads. */
export type CaseEventRecord = {
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown> | null;
};

/**
 * RF-182's input, built from what the case actually recorded — the case's
 * `deadline_expired` events joined to the `case_protocols` rows they were
 * measuring.
 *
 * **Why events and not arithmetic.** The obvious alternative is to look for
 * protocols whose `responseDueAt` is in the past. That answer changes every
 * time it is asked: a document generated a minute before a deadline and one
 * generated a minute after would disagree, and a case that was escalated for
 * an entirely different reason would still collect an expiry it never acted
 * on. `deadline_expired` is written once, by whoever actually decided the
 * deadline had passed (E5 Task 3's sweeper), so this reads a decision
 * instead of re-making one.
 *
 * **The `deadline_expired` payload contract**, set here and stated so Task 3
 * writes the same one (R3 in Task 4's report warns about exactly this kind
 * of divergence): `payload.stage` names the stage whose deadline expired. It
 * is the only key read. A row whose `stage` is missing, or is a string no
 * protocol of this case carries, contributes nothing — the pairing is a
 * match against the case's own `case_protocols` rows, never a lookup that
 * falls back to "the most recent protocol" when the stage does not line up.
 * Pairing an expiry with the wrong channel would put a protocol number from
 * one company's SAC into a sentence about another channel's silence.
 *
 * **An expiry with no protocol produces no sentence, on purpose.** That is
 * RF-186's stall — 30 days in which the person never wrote to the channel at
 * all — and there is no protocol number, no channel contact and no company
 * silence to cite. §9.1 routes it back to `sac` rather than onwards, so no
 * escalation document is being written from it either.
 */
export function collectExpiredDeadlines(input: {
  protocols: CaseProtocolRecord[];
  events: CaseEventRecord[];
}): ExpiredDeadline[] {
  const collected: ExpiredDeadline[] = [];
  const seen = new Set<string>();

  for (const event of input.events) {
    if (event.type !== "deadline_expired") continue;
    const stage = event.payload?.["stage"];
    if (typeof stage !== "string") continue;

    // The protocol the expired deadline was measuring: the most recent one
    // registered for that stage before the expiry was recorded. Most recent
    // rather than first, because a person who calls the SAC twice is waiting
    // on the second call's protocol — that is the number the channel itself
    // will look up, and the one whose `responseDueAt` the wait was restarted
    // from.
    let match: CaseProtocolRecord | undefined;
    for (const protocol of input.protocols) {
      if (protocol.stage !== stage) continue;
      if (protocol.registeredAt.getTime() > event.occurredAt.getTime()) continue;
      if (match === undefined || protocol.registeredAt.getTime() >= match.registeredAt.getTime()) {
        match = protocol;
      }
    }
    if (match === undefined) continue;

    const key = `${match.stage}|${match.protocolNumber}|${match.responseDueAt.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push({
      stage: match.stage,
      channel: match.channel,
      protocolNumber: match.protocolNumber,
      registeredAt: match.registeredAt,
      expiredAt: match.responseDueAt,
    });
  }

  return collected;
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
  const deadlinesExpired = input.deadlinesExpired ?? [];

  return {
    stage: input.stage,
    legalRefs: collectLegalRefs(input.findings),
    asks: stagePlaybook ? [...stagePlaybook.asks] : [],
    attachmentsChecklist: buildAttachmentsChecklist(stagePlaybook?.requiresPreviousProtocol ?? false),
    mandatoryScriptItems: [...MANDATORY_SCRIPT_ITEMS],
    protocols: input.protocols ?? [],
    deadlinesExpired,
    escalationHistory: deadlinesExpired.map(expiredDeadlineSentence),
  };
}
