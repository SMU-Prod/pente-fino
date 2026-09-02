import { z } from "zod";

export const ContestDocument = z.object({
  subject: z.string().max(120),
  body: z.string().min(200).max(4000),
  requests: z.array(z.string().max(200)).min(1).max(6),
  legalRefs: z.array(z.object({ law: z.string(), article: z.string() })).max(6),
  scriptForCall: z.array(z.string().max(200)).max(8),
  attachmentsChecklist: z.array(z.string().max(120)).max(8),
  /**
   * RF-182 (E5 Task 5): one finished sentence per deadline the case has
   * already let a channel run past, each naming the channel, the protocol
   * number and both dates — the date the protocol was registered and the
   * date the deadline expired.
   *
   * **A field of its own rather than prose inside `body`.** These are facts
   * the case recorded, not argument, and `ContestDocument` had nowhere to
   * put a recorded fact. Folding them into `body` would have meant either
   * asking the model to reproduce a protocol number and two dates (the one
   * thing a generator must never be trusted with, and the reason `legalRefs`
   * is not asked for either) or prepending them to model prose that is
   * already capped at 4000 characters, where a long draft would push the
   * finished document past its own schema and fail generation outright.
   * Here they are attached after generation, verbatim, exactly the way
   * `legalRefs`, `requests` and `attachmentsChecklist` already are.
   *
   * **Optional, not `.default([])`.** A default would type every
   * `ContestDocument` as *having* the array, and `case_documents.body` is a
   * `jsonb` column declared `$type<ContestDocument>()` — a cast, with no
   * parse on the way out. Every document E4 wrote before this field existed
   * would then be typed as carrying an array it does not carry, and the
   * first reader to trust that type would hit `undefined.map`. Optional says
   * what is true: a document may predate this field, and a reader must say
   * what it does about that.
   */
  escalationHistory: z.array(z.string().max(300)).max(6).optional(),
});

export type ContestDocument = z.infer<typeof ContestDocument>;
