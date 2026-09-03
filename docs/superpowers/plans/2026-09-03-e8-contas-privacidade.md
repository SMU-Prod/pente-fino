# E8 · Contas, privacidade e LGPD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Keep the promises the product already makes on screen. `apps/web/app/page.tsx`'s
footnote tells a person, in writing, that the file they upload is deleted in 30 days and that
no account is needed. E8 is where the rest of that sentence gets built: they can take their
data with them, they can ask for all of it to be destroyed and have that actually happen, they
can read what is shared with an AI provider and why, and nothing of theirs feeds the public
aggregate base unless they said yes first.

**Architecture:** Nothing here invents a second door to user data. Reads and writes go through
`withUser` (`packages/db/src/with-user.ts`), which the `pentefino/require-with-user` ESLint rule
already enforces. The purge is a scheduled job in `apps/jobs`, shaped exactly like RF-110's
`expire-files.ts`: system-scoped, error-isolated per subject, idempotent by construction, and
registered in `container.ts` + `SCHEDULABLE` + `vercel.json` + `SCHEDULE.md` (guards in both
directions fail if you do half).

## Global Constraints

Every task inherits these. They are not suggestions.

- **`INV-007`** — CPF, CNPJ, address, barcode and digitable line are masked before anything is
  persisted. Any text that reaches an `events` payload or a log line goes through `maskText`
  from `@pentefino/core` and is length-capped at 500 characters, exactly as
  `apps/jobs/src/tasks/expire-files.ts` and `dossier.ts` already do. CPF/CNPJ are recognised by
  **mod-11 check digits, not digit count** — never write a second detector; use
  `maskText`/`containsPii`.
- **`INV-008`** — no module outside `packages/db` imports `getUnscopedDb`, the `schema`
  namespace, a table by name, `@pentefino/db/testing` (outside a real test file), or a raw
  driver. Read `packages/config/eslint/rules/require-with-user.js` **before** writing any import
  from `@pentefino/db`. A legitimate system-scoped caller uses an explicit
  `// eslint-disable-next-line pentefino/require-with-user -- <reason>` on the same line, or has
  its export name added to `ALLOWED_PACKAGE_EXPORTS` with a comment saying why it hands out no
  raw data access.
- **`INV-004` / `INV-005`** — every user-facing string is pt-BR and is asserted against
  `lintUserFacingText` from `@pentefino/ai` in a test. No promise of an outcome, no legal
  vocabulary (§14.3).
- **`INV-009`** — nothing here creates a surface that sells anything to the company being
  complained about. The aggregate base is anonymous.
- **A3** — every state transition writes an `events` row. A new event name must be added to
  `packages/core/src/events.ts`'s `EVENTS` with a comment saying why it earns a name (renaming
  is what costs; see that file's header).
- ESM with `verbatimModuleSyntax`: `.js` extension on every relative import, `import type` for
  type-only imports. English code, comments and commit messages; user-facing strings pt-BR.
- Money is integer cents. Ids via `newId(prefix)`. Instants are `timestamptz`; civil dates are
  `date`. Enums are `text` + `CHECK` (§6.1).
- **Every new assertion must be watched failing before it is trusted.** Break the implementation
  deliberately, run the test, copy the real failure message into the report, restore. An
  assertion nobody saw go red is not evidence.
- **Never read a pnpm exit code through `| tail`** — the pipe swallows the status. Redirect to a
  file and echo `$?`, e.g.
  `pnpm --filter @pentefino/db test > /tmp/x.log 2>&1; echo "EXIT=$?"; tail -40 /tmp/x.log`.

**Gate (§18):** `invariants/masking` and `with-user` green.
`packages/core/test/invariants/masking.spec.ts` and
`packages/db/test/invariants/with-user.spec.ts` must both still pass at the end of every task.

**What already exists and must be used, not re-created:**

- `withUser(session, db)` — the only door. `Session` is `{ userId }` or `{ sessionId }`.
  `resolveSession(sessionId, db)` turns a raw cookie session id into whichever one applies, by
  following `anonymous_sessions.claimed_by_user_id`.
- `maskCanonical` / `maskText` / `containsPii` in `packages/core/src/invoice/mask.ts`.
- `apps/jobs/src/tasks/expire-files.ts` — RF-110's deletion job. The precedent for anything that
  removes stored bytes: per-subject try/catch, a `*_failed` event with a masked capped message,
  the subject left eligible for the next run, the run never aborting.
- The scheduler: `apps/web/app/api/cron/[task]/route.ts` (`SCHEDULABLE` allowlist, `CRON_SECRET`,
  closed by default), `apps/web/vercel.json`, `apps/web/app/api/cron/SCHEDULE.md`,
  `apps/web/test/routes/cron.test.ts` (drift guard reading `container.ts`) and
  `apps/web/test/container-tasks.test.ts` (enqueues every scheduled name against the real
  container).
- `users.deleted_at` already exists in `packages/db/src/schema.ts` and **nothing reads or writes
  it today**. It is the "exclusão em andamento" marker §13.2 asks for.
- `Storage` port (`packages/core/src/ports/storage.ts`) and `createLocalStorage`
  (`packages/adapters/src/storage/local.ts`) — HMAC-signed, really expiring, path-escape
  guarded. It has `signUpload`/`verify` and **no download signing at all**.

**The two things this block exists to get right, to be reported at the end:**

1. **Deletion has to actually delete.** Rows, stored files, and anything derived. A "deleted"
   account whose invoice PDF is still in the bucket passes every test that only checks the
   database. Note in particular that the **dossier PDF's only pointer is
   `events.payload.fileKey` on the `dossier_generated` event** — delete the events first and the
   PDF is orphaned in the bucket forever with no way left to find it.
2. **Export has to be complete without being a leak.** Signed links expire; a JSON dump that
   hands someone else's data to whoever holds the URL is worse than no export.

---

### Task 1: The consent column, the deletion marker, and the event names

**Files:** `packages/db/src/schema.ts`, `packages/db/migrations/`, `packages/core/src/events.ts`,
`packages/db/test/schema.test.ts`, `packages/core/src/events.test.ts`.

RF-245 needs a place to record consent, and it must default to off. Add
`users.aggregate_consent_at` as a nullable `timestamptz`. **Nullable timestamp, not a boolean
defaulting false**, and say why in the column comment: absence *is* "off", so the default is off
by construction rather than by a default value someone can change; and when it is on, the row
also carries the moment the person said yes, which a boolean throws away. Withdrawal sets it back
to `NULL`; the fact that a withdrawal happened lives in `events`, not in the column.

`users.deleted_at` already exists and is dead. Give it a comment saying what it now means: the
moment the person asked for the account to be destroyed. It is not a soft delete of the §6.1
"requisito legal de rastro" kind — the purge job deletes the row outright. It is a *pending*
marker, and while it is set the account is already unreachable.

Write the migration by hand as `packages/db/migrations/0001_<name>.sql` **and** update
`meta/_journal.json` and add `meta/0001_snapshot.json`, or run `pnpm --filter @pentefino/db
db:generate` if drizzle-kit can produce it offline. Either way, verify it applies: `createTestDb`
in `packages/db/src/testing.ts` replays every `.sql` file in sorted order, so
`pnpm --filter @pentefino/db test` failing to build a database is how you find out you got it
wrong. §6.1 wants additive, backwards-compatible migrations.

Add to `packages/core/src/events.ts`'s `EVENTS`, each with a comment in that file's established
voice explaining why the name is earned:

- `consent_granted`, `consent_withdrawn` — RF-245. `aggregate_consent_at` alone can never show
  that a withdrawal happened; the column only holds the current answer.
- `account_deletion_requested` — the moment the person asked. §13.2's "exclusão em andamento"
  state has to be readable, and the purge job needs the requested-at instant to report how long
  it took against RF-243's 24-hour promise.
- `account_deleted` — RF-243's audit event. It is the one row that **survives** the purge, and it
  carries no PII: `user_id` is `NULL` on the row and the payload holds a *hashed* user id.
- `account_purge_failed` — same reason `invoice_file_expiry_failed` exists: a per-subject failure
  that silently repeats forever must be visible.
- `data_exported` — RF-242. An export hands the person a complete copy of everything; if their
  session is later found to have been compromised, this row is the only trace it happened.

Do **not** add anything else to the catalogue. Each name is a contract.

---

### Task 2: Consent, read and written — and the gate that makes RF-245 true

**Files:** `packages/db/src/with-user.ts`, `packages/db/src/aggregation.ts` (new),
`packages/db/src/index.ts`, `packages/config/eslint/rules/require-with-user.js`,
`packages/db/test/`.

Three pieces.

**(a) `withUser(session).account()`** — the account row a screen and the export both need:
`id`, `email`, `plan`, `createdAt`, `aggregateConsentAt`, `deletedAt`. An anonymous session
(`{ sessionId }`) owns no `users` row, so this returns `null` — the same short-circuit `cases()`
and `caseDocument()` already use, for the same reason.

**(b) `withUser(session).setAggregateConsent(granted: boolean)`** — sets `aggregate_consent_at`
to now, or clears it, scoped to this caller's own `users` row and nobody else's. It writes a
`consent_granted` / `consent_withdrawn` event. **It must not write a second event when the state
is already what was asked for** — a screen that re-submits, or a double click, must not fill the
audit trail with noise that would make a real withdrawal impossible to find. Returns the state
after the call. `null` for an anonymous session.

**(c) The aggregation gate.** RF-245's acceptance is *"sem consentimento, a fatura não alimenta
`aggregates`"*. Nothing writes `aggregates` today — that arrives with E10/E11 — so the whole
requirement is about making it impossible to get wrong later, not about filtering a pipeline that
exists. Two halves, and both are needed:

- Export `invoicesEligibleForAggregation(db)` from `packages/db` (a new
  `src/aggregation.ts`, system-scoped like `closeCaseAsSystem` in `case-close.ts`): it returns
  only invoices whose owner is a `users` row with `aggregate_consent_at IS NOT NULL`. An invoice
  still owned by an anonymous session (`user_id IS NULL`) is **never** eligible — nobody
  consented, and there is no one to ask. Add the export name to `ALLOWED_PACKAGE_EXPORTS` in
  `require-with-user.js` with a comment explaining it hands out no raw data access, in the style
  of the `closeCaseAsSystem` entry already there.
- A drift guard test, in the spirit of `apps/web/test/routes/cron.test.ts`: scan the repository's
  own sources and fail if any module other than `packages/db/src/aggregation.ts` targets the
  `aggregates` table (`insert(aggregates`, `update(aggregates`, `schema.aggregates`, or a named
  import of `aggregates`). Explain in the test's comment that a bare eligibility function nobody
  is obliged to call is exactly the "capable, not live" state every job in this repo sat in
  before the scheduler existed, and that this guard is what makes the obligation real ahead of
  the writer that will have it.

Test the eligibility query with three invoices: a consenting user's, a non-consenting user's, and
an anonymous session's. Only the first comes back.

---

### Task 3: Signed download links

**Files:** `packages/core/src/ports/storage.ts`, `packages/adapters/src/storage/local.ts`,
`packages/adapters/src/storage/local.test.ts`.

RF-242 asks the export to carry *"links assinados para arquivos ainda retidos"*. The `Storage`
port can sign an upload and cannot sign a download at all.

Add `signDownload(fileKey: string): Promise<SignedDownload>` with
`SignedDownload = { url: string; expiresAt: string }`, and `verifyDownload(url)` mirroring the
existing `verify` (`{ fileKey, valid, reason?: "expired" | "bad_signature" }`). Implement both in
`createLocalStorage` with the same discipline the upload path already has: HMAC over the key and
the expiry, `timingSafeEqual` on fixed-length digests, and the key resolved through `pathFor` so a
key that escapes the storage root is refused before it can be signed.

Two decisions to make deliberately and record in the code:

- **The signature must be domain-separated from the upload signature.** Put a literal purpose
  string (`"download"` vs. `"upload"`) into the HMAC input, so a signature minted for one can
  never be replayed as the other. Say so in a comment and prove it with a test.
- **The TTL.** The upload TTL is 5 minutes. A download link goes *inside a JSON file the person
  downloads*, so whoever ends up holding that file holds the links — that is the leak this whole
  task has to bound. Pick a short lifetime, state the number as a named constant, and justify it
  in a comment against exactly that risk. It must be materially shorter than the 30-day retention
  the file itself has.

`packages/core`'s coverage floor is 90% on all four metrics; `src/ports/**` is excluded from it,
so the port change costs nothing there, but the adapter's does count in `packages/adapters`.

---

### Task 4: `GET /api/me/export` (RF-242)

**Files:** `packages/db/src/with-user.ts`, `apps/web/app/api/me/export/route.ts` (new),
`packages/db/test/`, `apps/web/test/routes/me-export.test.ts` (new).

**Acceptance:** the download contains the user's invoices, findings, cases, documents and events.

Add **one** `withUser(session).exportBundle()` method that assembles the whole thing inside
`packages/db` — not eight calls stitched together in the route. Every row it returns must be
reached through the same ownership filters the rest of that file uses: `invoices` and `events` by
their own `user_id`; `invoice_items` and `findings` joined through an owned invoice; `cases` by
`user_id`; `case_documents` and `case_protocols` joined through an owned case; `entitlements` by
`user_id`; the `users` row itself. An anonymous session returns `null` — §8.2 puts this under
`/api/me`, and there is no "me" without an account.

The route:

- Reads the session cookie, `resolveSession`s it, and **refuses an anonymous session with 403
  `forbidden`** via `apiError` from `@/lib/errors.js`.
- Serialises the bundle plus a `files` array: for each invoice whose `file_key` is still set
  *and* whose object still exists in storage (`storage.exists`), a `signDownload` link with its
  `expiresAt`; and for each `dossier_generated` event, the same for its `payload.fileKey`. An
  invoice whose file has already expired under RF-110 gets **no link and an explicit marker
  saying the file was deleted on that date** — the honest answer, and the one that matches the
  home page's own footnote.
- Sets `Content-Disposition: attachment`, a stable `Content-Type: application/json;
  charset=utf-8`, and **`Cache-Control: no-store`** — this response is the entire contents of a
  person's account and must never sit in a shared cache.
- Records a `data_exported` event.
- Carries a top-level pt-BR `aviso` string saying plainly that the links inside expire, and when.
  Lint it with `lintUserFacingText`.

Tests that must exist and must be watched failing:

- The bundle contains this user's invoice, item, finding, case, document, protocol and event.
- **A second user's rows appear nowhere in the serialised bundle.** Seed two users with data and
  assert on the serialised JSON string, not just on array lengths — an id leaking into a nested
  payload is exactly the failure a length check misses.
- An anonymous session gets 403 and no body containing rows.
- A retained file yields a link whose `verifyDownload` says valid; the same link is refused after
  its TTL passes (inject `now` into `createLocalStorage`, which already accepts it).
- An expired-file invoice yields the deleted-on marker and no link.

---

### Task 5: `DELETE /api/me` — the request, and cutting access immediately (RF-243, first half)

**Files:** `packages/db/src/with-user.ts`, `packages/db/src/claim.ts`,
`apps/web/app/api/me/route.ts` (new), tests in `packages/db/test/` and
`apps/web/test/routes/me-delete.test.ts` (new).

§8.2: `DELETE /api/me` — *exclusão de conta; purga em 24h*. This task is the request; Task 6 is
the purge.

`withUser(session).requestAccountDeletion()` stamps `users.deleted_at` and writes an
`account_deletion_requested` event. It is idempotent: a second call on an already-marked account
returns the same instant and writes **no** second event.

The route:

- Requires a resolved `{ userId }` session; anonymous → 403 `forbidden`.
- §13.3 requires a destructive action to be confirmed by typing. Enforce it on the server too,
  not only in the browser: require a JSON body `{ confirm: "EXCLUIR" }` and refuse anything else.
  This is a deliberate deviation from §8.2, which specifies no body — record it in the route's
  doc comment as a deviation and say why (a stray or forged `DELETE` must not be able to destroy
  an account). Reuse an existing `ERROR_CATALOGUE` code; do not invent one.
- **Clears the session cookie** (`SESSION_COOKIE`, `maxAge: 0`) so the browser is logged out in
  the same response.
- Returns `202` with `{ deletionRequestedAt, purgeDueAt }`.

**Then close the window this opens.** Between the request and the purge, the account still has
rows. Two places must stop treating it as live, and both need a test:

- `resolveSession` must not resolve to a user whose `deleted_at` is set. It falls back to
  `{ sessionId }`, which owns nothing: the claim migration nulls `invoices.session_id` and
  `events.session_id` when it moves them to the user, and `cases.user_id` is NOT NULL, so an
  anonymous session reaches zero rows. Every screen and route therefore goes dark at once,
  without a `deleted_at` check having to be repeated in each of them.
- `findOrCreateUser` in `claim.ts` must refuse to hand back a user row whose `deleted_at` is set.
  `users.email` is UNIQUE, so a second row for the same address is impossible, and re-claiming
  into a pending-deletion account would silently enqueue the person's *new* invoices for
  destruction. `confirmClaimCode` returns a distinct `reason` for this; the confirm route maps it
  to an existing catalogue code (`forbidden` reads truthfully here) rather than to `not_found`,
  and its doc comment records the trade-off — this is the one case the route's usual
  collapse-everything-into-`not_found` policy should not swallow, because the person on the other
  end is the account's own owner and a wrong message sends them in a circle. Once Task 6's purge
  removes the row, the same e-mail claims cleanly into a brand-new account.

---

### Task 6: The purge job (RF-243, second half) — and the scheduler wiring

**Files:** `apps/jobs/src/tasks/purge-accounts.ts` (new), `apps/jobs/src/index.ts`,
`apps/web/lib/container.ts`, `apps/web/app/api/cron/[task]/route.ts`,
`apps/web/vercel.json`, `apps/web/app/api/cron/SCHEDULE.md`,
`apps/web/test/routes/cron.test.ts`, `apps/web/test/container-tasks.test.ts`,
`apps/jobs/test/purge-accounts.test.ts` (new).

**Acceptance:** after the job, no row of the user exists; the audit event remains, with a hashed
`user_id`.

`createPurgeAccountsTask({ db, storage })`, modelled on `expire-files.ts` — read that file first
and follow its shape, including `resolveNow(payload, "purge-accounts")` from `../clock.js`.

Per user with `deleted_at IS NOT NULL`, isolated in its own try/catch so one failure never sinks
the run:

1. **Collect every storage key before deleting any row.** `invoices.file_key` for the user's
   invoices, *and* `payload.fileKey` from every `dossier_generated` event of that user. The
   dossier PDF has no other pointer anywhere in the schema: delete the events first and the object
   stays in the bucket forever with nothing left that knows its name. This ordering is the single
   most important line in the task.
2. Delete every collected object. `Storage.delete` is idempotent by contract (the local adapter's
   `rmSync(..., { force: true })` does not throw on a missing file), so an object already gone
   reaches the success path. **If any delete throws, record `account_purge_failed` with a masked,
   capped message and move to the next user, leaving every row in place** — a database wiped while
   the PDF survives is precisely the failure this block exists to prevent, and it is the one that
   passes a rows-only test.
3. In one transaction, delete the rows, in an order the foreign keys accept. Work the order out
   from `schema.ts` rather than from this list, but it must reach at least: `ai_calls` rows for the
   user's invoices and cases (no FK, so nothing cascades them — they are derived from the person's
   invoice and must go), `cases` (cascading `case_documents` and `case_protocols`), `invoices`
   (cascading `invoice_items` and `findings`), `entitlements`, `claim_codes` (which carry the
   **e-mail address** — PII in its own right), `anonymous_sessions` claimed by this user, `events`
   for the user *and* for those sessions, and finally the `users` row.
4. In the same transaction, insert the `account_deleted` audit event: `user_id` **NULL** on the
   row, and a payload carrying a SHA-256 hash of the user id plus counts and the requested/purged
   instants. No e-mail, no file keys, nothing that identifies a person. Say in a comment why a
   hash is enough here: after the purge the plaintext id exists nowhere, so the hash is a stable
   join key for auditing a deletion without being able to name whose it was.

What deliberately survives, said out loud in the module comment rather than left to be discovered:
`aggregates` rows, which are anonymous counters by construction and which RF-245's consent gate
already governs on the way in; and `rules`, `rule_metrics`, `agent_proposals`, `prompts`,
`issuers` and the reference tables, which are not the person's data at all.

**Wire it, all four ways, or the guards fail:** register `handlers.purgeAccounts` in
`container.ts`, add the name to `SCHEDULABLE` in the cron route and to `SCHEDULABLE_NAMES` in
`cron.test.ts` and `SCHEDULED` in `container-tasks.test.ts`, add a `vercel.json` cron entry, and
document the row in `SCHEDULE.md`'s table with its UTC time, its São Paulo time and its *why*.

**Choose the schedule against the promise.** RF-243 says *up to 24 hours*. A once-daily job's
worst case is a full day plus the run's own duration, which breaks the promise rather than
keeping it. Pick something that leaves headroom, put the reasoning in `SCHEDULE.md` next to the
Hobby-plan note that is already there, and name the plan tier it needs.

Tests (`apps/jobs/test/purge-accounts.test.ts`), following `expire-files.test.ts`'s setup:

- Every table the user had a row in is empty afterwards. Assert table by table, not by a count.
- **The uploaded invoice file and the dossier PDF are both gone from storage.** Assert with
  `storage.exists`.
- A storage delete that throws leaves **all** rows intact, records `account_purge_failed`, and the
  next run finishes the job.
- The `account_deleted` row survives, has `user_id` null, and its serialised payload contains
  neither the e-mail nor the raw user id.
- A user without `deleted_at` is untouched.
- Another user's rows and files are untouched.
- A second run is a no-op and writes no second `account_deleted`.

---

### Task 7: The transparency screen (RF-244)

**Files:** `apps/web/app/transparencia/page.tsx` (new), `apps/web/app/transparencia/content.ts`
(new), `apps/web/app/transparencia/transparencia.module.css` (new),
`apps/web/test/transparencia/content.test.ts` (new).

**Acceptance:** the text is present and versioned.

The content is data, not JSX prose: a `TRANSPARENCY_VERSION` (an integer, bumped on every change)
and a `TRANSPARENCY_UPDATED_AT` date, plus typed sections. Versioning is the acceptance criterion,
so it has to be a value a test can read and a screen can print, not a git history.

The text must describe **what this codebase actually does**, verified by reading it — not a
generic privacy blurb:

- Which provider receives invoice content, and through what
  (`packages/adapters/src/ai/gateway.ts` and the `AiProvider` port), and for what purposes
  (`ai_calls.purpose`: `classify`, `extract`, `contest`, `agent`).
- **What is sent and what is not.** `maskCanonical` runs between extraction and persistence
  (INV-007), and `packages/core/src/invoice/mask.ts`'s own header lists what it does *not* mask
  today — names, RG and e-mail addresses. Say so. A transparency page that overstates the
  masking is worse than none.
- That no credential of a third party is ever handled or stored (INV-002): the product produces
  text and a deep link, and the person sends it.
- Retention: 30 days for the uploaded file, or 7 days after a case closes, whichever comes first
  (RF-110, and read `expire-files.ts` for the actual rule). **This must agree with the home
  page's footnote**, which already says 30 days in `apps/web/app/page.tsx`.
- That the aggregate base is anonymous and opt-in, off by default (RF-245), and that nothing is
  ever sold to the company being complained about (INV-009).

Every string goes through `lintUserFacingText` in the test. Add a test that the version is a
positive integer and that no section is empty. Follow the CSS-module and design-token conventions
of `apps/web/app/home.module.css` and §13.1; §13.3 requires a written empty state and a visible
focus ring on every interactive element.

---

### Task 8: `/conta` — consent, export and deletion where a person can reach them

**Files:** `apps/web/app/api/me/consent/route.ts` (new), `apps/web/app/conta/page.tsx` (new),
`apps/web/app/conta/ConsentToggle.tsx` (new), `apps/web/app/conta/DeleteAccount.tsx` (new),
`apps/web/app/conta/conta.module.css` (new), `apps/web/app/conta/copy.ts` (new), tests.

§13.2 lists a **Conta** screen with the state *exclusão em andamento*. RF-245 requires the consent
to be **separado e destacado**, defaulting to off. RF-242 and RF-243 need a place a person can
actually reach them from.

`PUT /api/me/consent`, body `{ granted: boolean }`, calling Task 2's `setAggregateConsent`.
Anonymous session → 403 `forbidden`. Note in the route's doc comment that §8.2 lists no such
endpoint and that RF-245 cannot be met without one — this is an addition to the API contract, and
the PRD gap should be named rather than papered over.

The screen is a server component that reads the cookie, `resolveSession`s it and uses
`withUser(...).account()`. States to render, all with written text and never a blank:

- No account yet (anonymous session): explain that the laudo works without one and how claiming
  works — do **not** show export or deletion controls that cannot work.
- `free` / `premium` from `users.plan`.
- **Exclusão em andamento** when `deleted_at` is set, with the date the purge is due. This state
  must be reachable in a test.
- Trial and payment-failure are E9's states and have no data behind them yet; leave them out and
  say so in a comment rather than rendering something fake.

The consent control is its own bordered block, visually separate from everything else, labelled in
plain pt-BR: what feeding the anonymous aggregate base means, that it is off unless the person
turns it on, and that turning it off later stops it. Off is the rendered default when
`aggregateConsentAt` is null.

Deletion requires typed confirmation (§13.3): the button stays disabled until the person types the
exact word the API also checks. Say what will be destroyed and that it cannot be undone.

Export is a plain link to `/api/me/export` with an honest note about the links inside expiring.

Every string through `lintUserFacingText`. Keep the copy in a `copy.ts` module so the test can
enumerate it, the way `apps/web/app/laudo/[id]/copy.ts` already does.

---

## Reporting

At the end, report: the branch name, what was built, the two decisions in **The two things this
block exists to get right** above, every assertion that was watched failing with the message it
produced, and anything found wrong in `PRD.md`.
