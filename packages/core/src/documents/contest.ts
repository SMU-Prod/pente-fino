import { z } from "zod";

export const ContestDocument = z.object({
  subject: z.string().max(120),
  body: z.string().min(200).max(4000),
  requests: z.array(z.string().max(200)).min(1).max(6),
  legalRefs: z.array(z.object({ law: z.string(), article: z.string() })).max(6),
  scriptForCall: z.array(z.string().max(200)).max(8),
  attachmentsChecklist: z.array(z.string().max(120)).max(8),
});

export type ContestDocument = z.infer<typeof ContestDocument>;
