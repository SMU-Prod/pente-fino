import { cookies } from "next/headers";
import { resolveSession, withUser } from "@pentefino/db";
import { maskText } from "@pentefino/core";
import type { Storage } from "@pentefino/core/ports";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";
import { AVISO, FILE_LINK_UNAVAILABLE } from "./copy.js";

// Same cap `apps/jobs/src/tasks/expire-files.ts` and `dossier.ts` use for a
// per-subject failure message (INV-007): a storage error is attacker- or
// provider-influenced text, not something to trust verbatim into a response
// the person downloads and may forward.
const MAX_FAILURE_MESSAGE_LENGTH = 500;

/**
 * One entry of the response's `files` array - a download link for a stored
 * object this account owns, an honest marker when the object is already
 * gone, or an honest marker when the link could not be produced at all.
 * `source` says which part of the bundle the file belongs to;
 * `invoiceId`/`caseId` plus `eventId` (for a dossier, whose only pointer is
 * the `dossier_generated` event's payload, not a column) are what let the
 * person - or a tool reading the export later - match a file back to the
 * row it came from.
 *
 * **The `dossier`/`deletedAt` variant is never constructed today.** No job
 * in this repo expires or deletes a dossier PDF the way
 * `apps/jobs/src/tasks/expire-files.ts` does for an invoice's file - `store`
 * in `dossier.ts` writes it once and nothing since ever removes it. The
 * variant is kept, not dropped, because it is exactly the shape a future
 * dossier-expiry job would need to report an already-deleted dossier the
 * same honest way `invoiceFile` reports one below; deleting it now would
 * only mean re-adding the identical shape the day that job exists.
 */
type ExportFile =
  | { source: "invoice"; invoiceId: string; url: string; expiresAt: string }
  | { source: "invoice"; invoiceId: string; deletedAt: string }
  | { source: "invoice"; invoiceId: string; unavailable: string; reason: string }
  | { source: "dossier"; caseId: string; eventId: string; url: string; expiresAt: string }
  | { source: "dossier"; caseId: string; eventId: string; deletedAt: string }
  | { source: "dossier"; caseId: string; eventId: string; unavailable: string; reason: string };

/**
 * `storage.exists` first, `storage.signDownload` second - the split the
 * `Storage` port's own doc comment on `signDownload` calls out by name for
 * this exact route: `signDownload` never checks existence, so checking here
 * is what turns an already-expired invoice into the honest "deleted on"
 * marker RF-242 promises instead of a link that 404s the moment it is
 * clicked.
 *
 * A `fileKey` still set on the row whose object is nonetheless missing from
 * storage is a state RF-110's job should never produce - it clears `fileKey`
 * in the same transaction as the delete (`apps/jobs/src/tasks/expire-files.ts`)
 * - so there is no reliable date to put in a marker for it; the entry is
 * skipped rather than inventing one. Once `fileKey` is null, `fileExpiresAt`
 * is the exact instant that same job recorded the deletion, which is the
 * marker's date.
 */
async function invoiceFile(
  storage: Storage,
  invoice: { id: string; fileKey: string | null; fileExpiresAt: Date | null },
): Promise<ExportFile | null> {
  if (invoice.fileKey) {
    if (!(await storage.exists(invoice.fileKey))) return null;
    try {
      const { url, expiresAt } = await storage.signDownload(invoice.fileKey);
      return { source: "invoice", invoiceId: invoice.id, url, expiresAt };
    } catch (error) {
      // signDownload refuses any fileKey outside uploads/<owner>/<hash>.<ext>
      // (packages/adapters/src/storage/local.ts) - should never happen for a
      // key this storage minted itself, but one malformed row must not sink
      // the rest of the export. It must also not simply vanish from a dump
      // whose entire point is completeness: a file that exists but cannot be
      // linked right now would then be indistinguishable from one that never
      // existed. So the entry stays, carrying the same masked, length-capped
      // failure shape `apps/jobs/src/tasks/expire-files.ts` and `dossier.ts`
      // already use for a per-subject failure, rather than a `catch { return
      // null; }` that drops it.
      const reason = maskText(error instanceof Error ? error.message : String(error))
        .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
      return { source: "invoice", invoiceId: invoice.id, unavailable: FILE_LINK_UNAVAILABLE, reason };
    }
  }
  if (invoice.fileExpiresAt) {
    return { source: "invoice", invoiceId: invoice.id, deletedAt: invoice.fileExpiresAt.toISOString() };
  }
  return null; // this invoice never had a stored file (e.g. a csv/email source)
}

/**
 * Same exists-then-sign shape as `invoiceFile` above, for the one other
 * place a stored file is reachable at all: a `dossier_generated` event's
 * `payload.fileKey` (there is no job that expires a dossier file today, so
 * a missing object here has no reliable date to report either - skipped for
 * the same reason a stray missing invoice file is).
 */
async function dossierFile(
  storage: Storage,
  event: { id: string; caseId: string | null; payload: Record<string, unknown> },
): Promise<ExportFile | null> {
  if (!event.caseId) return null;
  const fileKey = event.payload.fileKey;
  if (typeof fileKey !== "string" || fileKey.length === 0) return null;
  if (!(await storage.exists(fileKey))) return null;
  try {
    const { url, expiresAt } = await storage.signDownload(fileKey);
    return { source: "dossier", caseId: event.caseId, eventId: event.id, url, expiresAt };
  } catch (error) {
    // Same reasoning as `invoiceFile`'s catch above: an entry that vanishes
    // here is indistinguishable from a dossier that was never generated, so
    // it stays, with the same masked, length-capped reason.
    const reason = maskText(error instanceof Error ? error.message : String(error))
      .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
    return { source: "dossier", caseId: event.caseId, eventId: event.id, unavailable: FILE_LINK_UNAVAILABLE, reason };
  }
}

/**
 * PRD §8.2 / RF-242: the complete export. `withUser(session).exportBundle()`
 * (`packages/db/src/with-user.ts`) does the one thing this route must not do
 * itself - assemble every owned row through INV-008's ownership filters -
 * and returns plain data with no storage access at all, by design (see that
 * method's doc comment): this route is the only place holding the real
 * `Storage` adapter, so turning a `fileKey` into a signed link, or into the
 * honest "already deleted" marker RF-110 makes possible, has to happen here.
 *
 * **Anonymous refuses with 403, not 404.** `exportBundle()` returns `null`
 * for a session with no `userId` - §8.2 puts this endpoint under `/api/me`,
 * and there is no "me" for a session that never claimed an account -
 * `apiError("forbidden")` is exact: identity was never established, which is
 * a different fact from "identity known, this is not yours" (`not_found`,
 * used by every other resource route in this app). There is nothing here
 * for `not_found` to distinguish: this route addresses no other id but the
 * caller's own account.
 *
 * **Cache-Control: no-store, always.** This response is the entire contents
 * of a person's account, plus signed links that are themselves bearer
 * capabilities for the short window they last - the one response in this
 * app that must never be written to a shared cache, a CDN, or a browser's
 * disk cache under any circumstance.
 *
 * **`data_exported` is recorded after the bundle is built, once ownership is
 * already proven** - the same ordering `case_viewed` uses on `/api/cases/:id`
 * and for the same two reasons: `recordEvent`'s `userId` comes from the
 * already-resolved `session`, so nothing here needs to happen before
 * ownership is settled, and a `forbidden` response must leave no trace that
 * differs from any other rejection (INV-008). The event's payload is `{}` -
 * *that* an export happened, and when, is the whole point (see this name's
 * own comment in `packages/core/src/events.ts`); it carries no description
 * of what was exported, since the export itself already is that record.
 */
export async function GET(_request: Request) {
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;
  if (!sessionId) return apiError("forbidden");

  const { db, storage } = container();
  const session = await resolveSession(sessionId, db);
  const scoped = withUser(session, db);

  const bundle = await scoped.exportBundle();
  if (!bundle) return apiError("forbidden");

  const files: ExportFile[] = [];
  for (const invoice of bundle.invoices) {
    const entry = await invoiceFile(storage, invoice);
    if (entry) files.push(entry);
  }
  for (const event of bundle.events) {
    if (event.type !== "dossier_generated") continue;
    const entry = await dossierFile(storage, event);
    if (entry) files.push(entry);
  }

  await scoped.recordEvent("data_exported", {});

  return Response.json(
    { ...bundle, files, aviso: AVISO },
    {
      headers: {
        "Content-Disposition": "attachment",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
