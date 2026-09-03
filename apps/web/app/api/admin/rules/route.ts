import { z } from "zod";
import { CATEGORIES, RULE_KINDS, type RuleDraftInput } from "@pentefino/core";
// eslint-disable-next-line pentefino/require-with-user -- rules and proposals are system configuration, not one user's data (packages/db/src/admin.ts's own header); RF-300/RF-301's admin CRUD has no session to scope by withUser.
import { RuleDraftError, createRuleVersion, listRuleFamilies } from "@pentefino/db";
import { requireAdmin } from "@/lib/admin.js";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";

// `LegalRef` (packages/core/src/rules/spec.ts) is a `packages/core`-owned
// type the same way `RuleSpec` is; `effect` is left a bare string here for
// the same reason `spec` below is left a shallow passthrough — re-typing its
// six-value union in zod would be a second copy that can silently drift from
// the one `packages/core` already declares. `validateRuleDraft` does not
// currently re-check `effect` either (it only checks `legalBasis.length`),
// so this schema is not withholding a check `createRuleVersion` would
// otherwise perform.
const LegalRefBody = z.object({
  law: z.string(),
  article: z.string(),
  effect: z.string(),
  note: z.string().optional(),
});

// Shape only, at the edge — PRD §18's RF-301 CRUD body, verbatim. `spec`'s
// own union (RuleSpec's `kind` discriminant and its per-kind fields) is
// `packages/core`'s type to own; rebuilding it here would be a second source
// of truth that drifts the moment a kind is added there and not here.
// `validateRuleDraft`, run inside `createRuleVersion`, is what actually
// judges whether `spec` (and `legalBasis`, and everything else) make sense —
// this schema only guarantees the request has *a* spec object with *a* kind
// string to hand it. `author` is deliberately not a field here: see POST's
// doc comment.
const Body = z.object({
  slug: z.string().min(1),
  category: z.enum(CATEGORIES),
  issuerId: z.string().min(1).nullable(),
  kind: z.enum(RULE_KINDS),
  spec: z.object({ kind: z.string() }).passthrough(),
  legalBasis: z.array(LegalRefBody),
  confidenceBase: z.number(),
  reason: z.string(),
});

/**
 * `GET /api/admin/rules` — RF-300's rule-family listing (every version,
 * grouped by slug, with cumulative metrics and pending-promotion state; see
 * `listRuleFamilies`'s own doc comment). No query parameters: this is the
 * whole catalogue, and it is small (there is no per-tenant partition of
 * rules to page through).
 *
 * **A non-admin gets `not_found`, never `forbidden`.** A 403 would confirm
 * the admin surface exists to anyone who probes for it — the exact same
 * request from a stranger and from a legitimate admin whose session merely
 * expired would look identical either way, so there is nothing to gain and
 * a fingerprint to lose by distinguishing them. `requireAdmin`'s own doc
 * comment gives the identical reasoning for folding every authorization
 * failure into one `null`; this route just carries that `null` through to
 * one HTTP code instead of several.
 */
export async function GET() {
  const { db } = container();
  const admin = await requireAdmin(db);
  if (!admin) return apiError("not_found");

  const families = await listRuleFamilies(db);
  return Response.json({ families });
}

/**
 * `POST /api/admin/rules` — RF-301's "editar cria nova versão, a anterior
 * vira histórico". `author` is never read from the body: it is the
 * authenticated admin's e-mail, the same way `decidedBy` on a proposal
 * decision is (`proposals/[id]/route.ts`). A rule version that let its own
 * caller *claim* who authored it would make the append-only history (global
 * constraint 6) unable to say who actually wrote a rule — only who the
 * request happened to say wrote it, which is not a record of anything.
 *
 * A malformed body — unparsable JSON, or one that fails the shape check
 * above — folds into `not_found`, the same as every other route in this app:
 * there is no dedicated validation-failure code for it, and a body this
 * route cannot use is already an anomaly.
 *
 * A `RuleDraftError` — `validateRuleDraft`'s problems, thrown from inside
 * `createRuleVersion` once the body's *meaning* is checked, not just its
 * shape — is different: it is a real, actionable rejection an admin filling
 * in a form needs to see, so it becomes `422` with the pt-BR `problems`
 * array as `details` (`rule_invalid`, `apps/web/lib/errors.ts`), not a
 * generic `not_found`.
 */
export async function POST(request: Request) {
  const { db } = container();
  const admin = await requireAdmin(db);
  if (!admin) return apiError("not_found");

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiError("not_found");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return apiError("not_found");

  const input: RuleDraftInput = {
    slug: parsed.data.slug,
    category: parsed.data.category,
    issuerId: parsed.data.issuerId,
    kind: parsed.data.kind,
    spec: parsed.data.spec as unknown as RuleDraftInput["spec"],
    legalBasis: parsed.data.legalBasis as unknown as RuleDraftInput["legalBasis"],
    confidenceBase: parsed.data.confidenceBase,
    author: admin.email,
    reason: parsed.data.reason,
  };

  try {
    const result = await createRuleVersion(db, input);
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof RuleDraftError) {
      return apiError("rule_invalid", error.problems);
    }
    throw error;
  }
}
