import { cookies } from "next/headers";
import { resolveSession, withUser } from "@pentefino/db";
import type { Storage } from "@pentefino/core/ports";
import { container } from "@/lib/container.js";
import { apiError } from "@/lib/errors.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";
import { AVISO } from "./copy.js";

/**
 * One entry of the response's `files` array - a download link for a stored
 * object this account owns, or (when the object is already gone) an honest
 * marker instead of a dead link. `source` says which part of the bundle the
 * file belongs to; `invoiceId`/`caseId` plus `eventId` (for a dossier, whose
 * only pointer is the `dossier_generated` event's payload, not a column) are
 * what let the person - or a tool reading the export later - match a file
 * back to the row it came from.
 */
type ExportFile =
  | { source: "invoice"; invoiceId: string; url: string; expiresAt: string }
  | { source: "invoice"; invoiceId: string; deletedAt: string }
  | { source: "dossier"; caseId: string; eventId: string; url: string; expiresAt: string }
  | { source: "dossier"; caseId: string; eventId: string; deletedAt: string };

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
    } catch {
      // signDownload refuses any fileKey outside uploads/<owner>/<hash>.<ext>
      // (packages/adapters/src/storage/local.ts) - should never happen for a
      // key this storage minted itself, but one malformed row must not sink
      // the rest of the export.
      return null;
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
  } catch {
    return null;
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
