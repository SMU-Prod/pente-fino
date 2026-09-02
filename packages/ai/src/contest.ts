import { z } from "zod";
import { ContestDocument } from "@pentefino/core";
import type { AssembledContest } from "@pentefino/core";
import type { AiUsage } from "@pentefino/core/ports";
import { lintUserFacingText } from "./lint.js";

/**
 * What the model is actually asked for (RF-160). Three fields only, and
 * deliberately not the rest of `ContestDocument`:
 *
 *   - `legalRefs` is never here. RF-161 is explicit: legal references come
 *     only from `assembleContest`'s reading of the findings' own
 *     `legalBasis` (`packages/core/src/documents/assemble.ts`), and are
 *     attached to the candidate document in `buildCandidateDocument` below,
 *     after generation. Asking the model for `legalRefs` at all would be the
 *     exact hallucination-by-invitation RF-161 exists to rule out, so the
 *     schema this module validates against cannot even accept one.
 *   - `requests` is never here either. `assembleContest`'s own doc comment
 *     (Task 1) calls the stage's playbook `asks` "requirements of the
 *     document, not suggestions to a model" — so §20.4's highest-weighted
 *     eval criterion ("contains every playbook ask for the stage") is met by
 *     construction, not by hoping the model reproduced every item. See
 *     `buildCandidateDocument`.
 *   - `attachmentsChecklist` is never here. RF-165 is derived purely from
 *     the stage (`assembleContest.attachmentsChecklist`) — the design's own
 *     dependency table marks it "não vem do modelo".
 *   - `escalationHistory` is never here either, and for the sharpest version
 *     of the same reason. RF-182's acceptance is that the document contains
 *     a protocol number and two specific dates; a model asked to reproduce
 *     those would sometimes transpose a digit or a month, and the result
 *     would be a document making a checkable factual claim about a company's
 *     silence with the wrong number on it. `assembleContest` writes those
 *     sentences (`AssembledContest.escalationHistory`) and
 *     `buildCandidateDocument` attaches them verbatim.
 *
 * `scriptForCall` here is only the model's OWN additional lines — RF-163's
 * two mandatory items (protocol number, call recording) are never left to
 * chance either; `buildCandidateDocument` prepends
 * `assembled.mandatoryScriptItems` before this array ever reaches the
 * final document. `min(1)` guarantees at least one model-authored line on
 * top of the two mandatory ones, which is what makes the RF-163 acceptance
 * ("no mínimo 3 itens") true by construction rather than by luck.
 */
export const ContestDraft = z.object({
  subject: ContestDocument.shape.subject,
  body: ContestDocument.shape.body,
  scriptForCall: z.array(z.string().max(200)).min(1).max(6),
});
export type ContestDraft = z.infer<typeof ContestDraft>;

/**
 * The prose-relevant slice of a `Finding` (`packages/core/src/rules/
 * finding.ts`) that the prompt needs in order to describe what is actually
 * being contested — and, just as deliberately, not the rest of it.
 * `legalBasis` is not projected through: the prompt already instructs the
 * model never to cite a legal basis (RF-161), and simply never showing it
 * the citation data is a second, structural line of defense against the
 * model reaching for it anyway. `ruleSlug`, `ruleVersion` and `confidence`
 * are internal bookkeeping with nothing to say to a person reading a
 * letter about their own bill.
 */
export type ContestFindingContext = {
  evidence: string[];
  amountCents: number;
  doubledCents: number | null;
};

/**
 * RF-160's structured input, as this generator receives it. `assembled` is
 * Task 1's deterministic half (`assembleContest`) — the stage, the legal
 * references, the playbook's asks, the attachment checklist, the mandatory
 * script items, and any protocols already on record. `findings` supplies
 * the prose-relevant context `assembled` does not carry (concrete amounts
 * and evidence), sanitized through `ContestFindingContext` so the model
 * never sees a legal citation to reach for.
 *
 * `deadlinesExpired` (RF-160's third structured-input element per the PRD's
 * literal wording, and RF-182's own requirement that "o gerador recebe
 * `deadlinesExpired`") arrives **inside `assembled`**, not as a fourth field
 * here. E4 left it out rather than invent a shape that would collide with
 * E5's; E5 Task 5 defined it on `AssembleContestInput`/`AssembledContest`
 * (`packages/core/src/documents/assemble.ts`), which is where the deadline
 * calendar and the case's recorded protocols already are.
 *
 * A second, top-level copy here would be strictly worse: `assembled` also
 * carries `escalationHistory`, the finished sentences derived from exactly
 * those entries, and two independently-settable fields is two ways for the
 * structured facts and the printed sentence to disagree about the same
 * protocol.
 */
export type ContestPromptInput = {
  issuerName: string;
  assembled: AssembledContest;
  findings: ContestFindingContext[];
};

/**
 * The model call itself, as an injectable seam — same shape of contract as
 * `GenerateObjectFn` in `packages/adapters/src/ai/gateway.ts`: production
 * code injects the real call, tests inject a stand-in that returns a canned
 * result, and this module's own logic (the two gates below, and RF-161's
 * attachment) is exercised without a network call and without mocking
 * `fetch`. `draft` is `unknown`, not `ContestDraft`, on purpose — the whole
 * point of the schema gate is to handle a response that does NOT satisfy
 * `ContestDraft`, which a typed return value could not represent.
 *
 * `generate` being absent (rather than a function that always fails) is
 * this module's representation of "no AI provider is configured at all" —
 * the same distinction `apps/jobs/src/tasks/ingest.ts`'s `IngestDeps.ai`
 * already draws for extraction. See `generateContestDocument`'s
 * `not_configured` branch.
 */
export type GenerateContestFn = (
  input: ContestPromptInput,
  promptBody: string,
) => Promise<{ draft: unknown; usage: AiUsage }>;

export type ContestGenerationReason = "not_configured" | "no_asks" | "generation_failed";

/**
 * A8: when this generator cannot produce a document, it says so clearly,
 * never returning a partial or template-stitched one instead. `reason` lets
 * a caller (a future route) map this to §8.1's `{ error: { code, message } }`
 * shape without parsing the message text — the same reasoning
 * `ingestErrorReason` documents for extraction's own tagged errors.
 */
export class ContestGenerationError extends Error {
  readonly reason: ContestGenerationReason;

  constructor(reason: ContestGenerationReason, message: string) {
    super(message);
    this.name = "ContestGenerationError";
    this.reason = reason;
  }
}

export type GenerateContestResult = {
  document: ContestDocument;
  /** One entry per model call actually made (1, or 2 when a retry happened) — an honest ledger, not a guess. */
  usages: AiUsage[];
};

// RF-160/RF-162: one regeneration, whatever the reason for the first
// attempt's rejection. Not two independent budgets (one for the schema gate,
// one for the lint gate) — the design's own §6 frames it as the same
// mechanism serving both: "RF-160 já regenera uma vez quando o schema
// rejeita, e o RF-162 acrescenta a regeneração por vocabulário". A document
// that still fails either gate on this second attempt becomes the one clear
// error below, never a partially sanitized document.
const MAX_ATTEMPTS = 2;

type CandidateDocument = z.infer<typeof ContestDocument>;

/**
 * RF-161's attachment point, and the only one. `assembled.legalRefs` is
 * projected down to `{ law, article }` — `ContestDocument.legalRefs` has no
 * `effect`/`note` fields, unlike the richer `LegalRef` the rule engine
 * carries — but every entry is otherwise untouched: no reformatting, no
 * reordering, no merge with any other source.
 *
 * `requests` and `attachmentsChecklist` are the same story: `assembled.asks`
 * and `assembled.attachmentsChecklist` pass straight through, verbatim,
 * never merged with anything the model proposed (the model was never even
 * asked for them — see `ContestDraft`'s doc comment).
 *
 * --- The decision this task's brief asked for, made explicit -------------
 *
 * §20.2's playbook carries its OWN `legalRefs` per stage (e.g. Decreto
 * 11.034/2022 art. 13 grounding the SAC stage's suspension ask; CDC art. 42
 * grounding `consumidor_gov`'s doubled-refund ask) — real citations, seeded
 * from the PRD, not invented by a model. Task 1 deliberately never reads
 * `playbook.stages[...].legalRefs` when building `AssembledContest.legalRefs`
 * (see `assemble.ts`'s own doc comment and the test asserting it), because
 * RF-161's acceptance is unconditional: "achados com base legal X produzem
 * documento contendo só X" — only X, not X plus whatever the stage usually
 * cites too.
 *
 * This function honors that same line, on purpose: a stage's own legal
 * basis for its own asks NEVER appears anywhere in the generated document —
 * not in `legalRefs` (which would break the "only X" guarantee outright),
 * and not woven into `body` prose either (the prompt instructs the model
 * never to cite a legal basis at all, precisely so a real-but-not-this-
 * case's-own citation cannot slip in through the back door of free text).
 * The request itself ("suspensão imediata da cobrança contestada") still
 * reaches the document through `requests`, unconditionally — it simply
 * reaches it as a plain consumer ask, uncited, exactly like the singular
 * first person the PRD already asks these letters to speak in. Grounding a
 * stage's own procedural asks in their own legal basis is a real, separate
 * idea worth having, but it is not this: it would mean widening
 * `AssembledContest`'s contract itself (a Task 1 concern, already landed and
 * tested) to carry a second, clearly-labeled citation source alongside
 * `legalRefs`, deliberately kept out of whatever RF-161's "only X" acceptance
 * test checks. That is future work, not a silent addition here.
 */
function buildCandidateDocument(assembled: AssembledContest, draft: ContestDraft): CandidateDocument {
  return {
    subject: draft.subject,
    body: draft.body,
    requests: assembled.asks,
    legalRefs: assembled.legalRefs.map(({ law, article }) => ({ law, article })),
    scriptForCall: [...assembled.mandatoryScriptItems, ...draft.scriptForCall],
    attachmentsChecklist: assembled.attachmentsChecklist,
    // RF-182, attached the same way and for the same reason as `legalRefs`:
    // the protocol number and the two dates are recorded facts about this
    // case, and the model is never given the chance to restate them.
    escalationHistory: assembled.escalationHistory,
  };
}

type LintViolationSite = { field: string; term: string };

/**
 * RF-162's gate, swept over exactly the surface the acceptance names —
 * `subject`, `body`, each `requests` entry, each `scriptForCall` line, each
 * `attachmentsChecklist` label — the identical field list
 * `packages/ai/test/invariants/authorship.spec.ts` sweeps for INV-003.
 * `legalRefs` is deliberately excluded: it is structured law/article data
 * attached by `buildCandidateDocument`, not prose, and its own correctness
 * is RF-161's concern (see that function's doc comment), not this gate's.
 *
 * Every field is linted, including the deterministic ones (`requests`,
 * `attachmentsChecklist`) that never passed through the model at all. A
 * violation there cannot come from a bad generation — it would mean a
 * misconfigured `Playbook` or a bad `assembleContest` output slipped a
 * forbidden term into a document field — but RF-162 says the gate runs on
 * "every string the document can show", not only the ones the model wrote,
 * so this stays uniform rather than special-casing which fields are
 * "trusted" enough to skip.
 */
function findLintViolations(candidate: CandidateDocument): LintViolationSite[] {
  const violations: LintViolationSite[] = [];
  const sweep = (field: string, text: string): void => {
    const result = lintUserFacingText(text);
    for (const violation of result.violations) violations.push({ field, term: violation.term });
  };
  sweep("subject", candidate.subject);
  sweep("body", candidate.body);
  candidate.requests.forEach((request, i) => sweep(`requests[${i}]`, request));
  candidate.scriptForCall.forEach((line, i) => sweep(`scriptForCall[${i}]`, line));
  candidate.attachmentsChecklist.forEach((label, i) => sweep(`attachmentsChecklist[${i}]`, label));
  // RF-182's sentences. Deterministic, like `requests` and
  // `attachmentsChecklist` — and swept for the same reason those are: the
  // gate runs on every string the document can show, not only the ones the
  // model wrote. The variable parts here are a channel name and a protocol
  // number that both come from a person typing into a form, so this is not
  // a theoretical surface.
  (candidate.escalationHistory ?? []).forEach((line, i) => sweep(`escalationHistory[${i}]`, line));
  return violations;
}

/**
 * RF-160's generator, with RF-162's lint gate in front of display and
 * RF-161's legal references attached, never generated (see
 * `buildCandidateDocument`'s doc comment for that decision in full).
 *
 * Two preconditions are checked before any model call is ever made, both
 * honest refusals rather than a document built on thin air (A8):
 *
 *   - `generate` absent means no AI provider is configured at all (see
 *     `GenerateContestFn`'s doc comment) — refuses immediately with
 *     `reason: "not_configured"`. This is the one guarantee this task's
 *     brief calls out explicitly: without a key, this function never
 *     assembles prose from fixed templates as a substitute for a real
 *     generation. There is no template path in this module at all.
 *   - `assembled.asks` empty means the stage has no playbook requests to
 *     build a document around — `requests` comes from `assembled.asks`
 *     verbatim (never invented by the model, see `buildCandidateDocument`),
 *     so an empty list here is not a document with zero requests, it is a
 *     stage this generator cannot honestly produce a letter for yet.
 *
 * Then, up to `MAX_ATTEMPTS` real attempts: each one calls `generate`,
 * validates the result against `ContestDraft` (the schema gate, RF-160),
 * and — only if that passes — builds the candidate document and runs it
 * through `findLintViolations` (the lint gate, RF-162) before ever
 * returning it. Either failure moves to the next attempt; exhausting
 * `MAX_ATTEMPTS` throws `reason: "generation_failed"` with the last
 * failure's own detail, and the `usages` already spent are attached to the
 * thrown error so a caller can still log what was paid for even though
 * nothing usable came out of it.
 *
 * The final `ContestDocument.parse` is deliberate defense in depth (A7),
 * the same reasoning `gateway.ts`'s own re-parse of `result.object`
 * documents: `buildCandidateDocument` is trusted code, not an external
 * response, but parsing again is cheap and means this function's return
 * type is never a lie.
 */
export async function generateContestDocument(
  input: ContestPromptInput,
  promptBody: string,
  generate: GenerateContestFn | undefined,
): Promise<GenerateContestResult> {
  if (input.assembled.asks.length === 0) {
    throw new ContestGenerationError(
      "no_asks",
      `Não é possível gerar o texto da contestação: a etapa "${input.assembled.stage}" não tem pedidos ` +
        "definidos no playbook do emissor.",
    );
  }

  if (!generate) {
    throw new ContestGenerationError(
      "not_configured",
      "Não é possível gerar o texto da contestação: nenhum provedor de IA está configurado.",
    );
  }

  const usages: AiUsage[] = [];
  let lastFailureDetail = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { draft: rawDraft, usage } = await generate(input, promptBody);
    usages.push(usage);

    const parsedDraft = ContestDraft.safeParse(rawDraft);
    if (!parsedDraft.success) {
      lastFailureDetail = `o schema rejeitou a resposta do modelo (${parsedDraft.error.message})`;
      continue;
    }

    const candidate = buildCandidateDocument(input.assembled, parsedDraft.data);
    const violations = findLintViolations(candidate);
    if (violations.length > 0) {
      const summary = violations.map((v) => `${v.field}: "${v.term}"`).join(", ");
      lastFailureDetail = `o texto continha vocabulário proibido (${summary})`;
      continue;
    }

    const document = ContestDocument.parse(candidate);
    return { document, usages };
  }

  throw Object.assign(
    new ContestGenerationError(
      "generation_failed",
      `Não foi possível gerar um documento válido após ${MAX_ATTEMPTS} tentativas: ${lastFailureDetail}.`,
    ),
    { usages },
  );
}
