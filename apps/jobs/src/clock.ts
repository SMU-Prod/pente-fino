/**
 * The one injected clock every scheduled task in this app reads "now" from.
 *
 * A `TaskHandler`'s own deps are fixed by whatever `create*Task` declares,
 * and none of them carry a clock — so a test that needs a deterministic
 * "today" (the E1 and E5 briefs are both explicit: no wall-clock time in a
 * test) has one place left to inject one: the payload every `TaskHandler`
 * already accepts, the same way `{ invoiceId }` rides `ingest`'s payload.
 * Production's own scheduler call passes no `now` at all and gets the real
 * clock.
 *
 * Extracted from `expire-files.ts`, where this started as a private
 * function, when `case-deadlines.ts` needed the same thing. Copying it
 * would have made "the established pattern" two patterns that could drift —
 * and a second job silently accepting a payload shape the first rejects is
 * exactly the kind of divergence nobody notices until a date is wrong in
 * production.
 *
 * `task` is only used to name the job in the error, so a malformed payload
 * says which handler rejected it rather than leaving that to a stack trace.
 */
export function resolveNow(payload: Record<string, unknown>, task: string): Date {
  const raw = payload.now;
  if (raw === undefined) return new Date();
  if (raw instanceof Date) return raw;
  if (typeof raw === "string" || typeof raw === "number") return new Date(raw);
  throw new Error(`${task}: payload.now must be a Date, string or number, got ${typeof raw}`);
}
