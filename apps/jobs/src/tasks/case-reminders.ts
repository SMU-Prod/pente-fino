import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { newId, type Stage } from "@pentefino/core";
import type { Mailer } from "@pentefino/core/ports";
import type { TaskHandler } from "@pentefino/adapters";
// eslint-disable-next-line pentefino/require-with-user -- system job with no user session; every write goes through the caller-injected `Database` (deps.db), not a client this module creates itself
import { schema, type Database } from "@pentefino/db";
import { resolveNow } from "../clock.js";
import { USER_ACTION_EVENTS } from "./case-deadlines.js";

const { cases, events, users } = schema;

export type CaseRemindersDeps = {
  db: Database;
  mailer: Mailer;
  /**
   * Where the case lives, for the link in the reminder. A reminder that
   * cannot be acted on is worse than no reminder — it tells someone their
   * case needs attention and leaves them to find it.
   *
   * Required, with no default: guessing at a base URL would send people to
   * the wrong host, and in an e-mail that reaches a real inbox a wrong link
   * is not something a later fix can take back.
   */
  appBaseUrl: string;
};

/**
 * RF-185's suppression window. A person who looked at their case this
 * morning does not need an e-mail this afternoon telling them to look at
 * it.
 *
 * The suppression *is* the requirement, not a nicety around it: a product
 * that mails you about something you just read is a product you mute, and a
 * muted channel delivers nothing at all — which is the same outcome as
 * having no reminders, arrived at by way of annoying someone first.
 */
export const SUPPRESSION_WINDOW_HOURS = 24;
const SUPPRESSION_WINDOW_MS = SUPPRESSION_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Why a person is being reminded. Each reason is reminded about at most
 * once per occurrence, which is what `case_reminder_sent` records.
 *
 * `stalled` is RF-186's "lembrete final": the case has sat in a channel
 * nobody ever wrote to, and it closes 30 days from the stall unless the
 * person acts. It is the one reminder with a deadline of its own behind it.
 *
 * `deadline_expired` is RF-185's own case: the company's window ran out,
 * the case moved up a rung, and there is a next step waiting for the person
 * to take.
 */
export const REMINDER_REASONS = ["stalled", "deadline_expired"] as const;
export type ReminderReason = (typeof REMINDER_REASONS)[number];

type Copy = { subject: string; body: (caseUrl: string) => string };

/**
 * pt-BR, and inside §14.3's vocabulary (INV-004/INV-005): nothing here
 * promises an outcome, and nothing presents the product as the author or
 * the sender of anything (INV-003). The reminder tells the person what
 * happened and where to look; the acting is theirs.
 */
const COPY: Record<ReminderReason, Copy> = {
  stalled: {
    subject: "Seu caso está parado há 30 dias",
    body: (caseUrl) => [
      "Faz 30 dias que o seu caso não recebe um número de protocolo.",
      "",
      "Sem protocolo não há nada para cobrar de ninguém — é ele que prova que",
      "você procurou a empresa e quando. Se você já falou com o canal, é só",
      "colar o número; se ainda não falou, o texto para enviar está pronto na",
      "página do caso.",
      "",
      `Abrir o caso: ${caseUrl}`,
      "",
      "Se nada acontecer nos próximos 30 dias, encerramos o caso.",
    ].join("\n"),
  },
  deadline_expired: {
    subject: "O prazo da empresa venceu",
    body: (caseUrl) => [
      "A empresa tinha um prazo para responder e ele venceu.",
      "",
      "O seu caso já avançou para a próxima etapa, e o texto dessa etapa cita",
      "o protocolo anterior e as duas datas. Quem envia é você, no seu nome.",
      "",
      `Abrir o caso: ${caseUrl}`,
    ].join("\n"),
  },
};

/**
 * RF-185's reminders.
 *
 * ## The shape
 *
 * A sweep, like `case-deadlines.ts`, and for the same reason: what has to
 * survive a restart is the *fact* that something happened to a case, and
 * that fact is already in `events`. Nothing here holds a timer.
 *
 * Per open case, per reason: if the trigger event has occurred and no
 * `case_reminder_sent` for that reason has been written since it, the
 * person is reminded — unless they have acted in the last 24 hours.
 *
 * ## Layers, and the one that does not exist yet
 *
 * RF-185 asks for push first, then e-mail. **Push is E12** — there is no
 * device token, no APNs/FCM adapter and no app to receive it. So this job
 * sends e-mail only, and says so here rather than pretending the layer
 * exists: a reminder path that silently no-ops looks delivered and is not,
 * which is precisely the class of failure this codebase keeps finding.
 *
 * When push arrives it goes in front of the mail send, and the
 * `case_reminder_sent` payload's `channel` field is where it is recorded —
 * the field is written now, with `"email"`, so the event's shape does not
 * have to change for it.
 *
 * ## What the e-mail path has and has not been proven to do
 *
 * With no `RESEND_API_KEY`, `buildAdapters` selects the local mailer, which
 * writes each message to a file. That exercises composition, escaping and
 * the header-injection rejection — everything except an SMTP hop. **Nobody
 * has yet seen one of these arrive in a real inbox**, and no test in this
 * repo can establish that.
 *
 * ## Suppression, and why it does not mark the reminder as sent
 *
 * A suppressed reminder writes no event at all. The person was not
 * reminded, so recording that they were would be a lie in the timeline —
 * and, worse, it would consume the one reminder that reason ever gets. A
 * case suppressed today is a candidate again tomorrow.
 */
export function createCaseRemindersTask(deps: CaseRemindersDeps): TaskHandler {
  const { db, mailer, appBaseUrl } = deps;

  return async function caseReminders(payload: Record<string, unknown>): Promise<void> {
    const now = resolveNow(payload, "case-reminders");
    const suppressBefore = new Date(now.getTime() - SUPPRESSION_WINDOW_MS);

    const open = await db
      .select({ id: cases.id, userId: cases.userId, invoiceId: cases.invoiceId, stage: cases.stage })
      .from(cases)
      .where(and(ne(cases.stage, "closed"), isNull(cases.closedAt)));
    if (open.length === 0) return;

    const caseIds = open.map((row) => row.id);

    // One read of everything this run reasons about: the trigger events, the
    // reminders already sent, and the user actions that suppress. Ordered
    // newest-first so the first row seen per (case, type) is the latest one.
    const relevant = await db
      .select({
        caseId: events.caseId,
        type: events.type,
        payload: events.payload,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(and(
        isNotNull(events.caseId),
        inArray(events.caseId, caseIds),
        inArray(events.type, [
          "case_stalled", "deadline_expired", "case_reminder_sent", ...USER_ACTION_EVENTS,
        ]),
      ))
      .orderBy(desc(events.occurredAt), desc(events.id));

    type Seen = {
      trigger: Partial<Record<ReminderReason, Date>>;
      reminded: Partial<Record<ReminderReason, Date>>;
      lastAction: Date | null;
    };
    const seen = new Map<string, Seen>();
    const userActions = new Set<string>(USER_ACTION_EVENTS);

    for (const row of relevant) {
      if (!row.caseId) continue;
      const entry = seen.get(row.caseId)
        ?? { trigger: {}, reminded: {}, lastAction: null };

      if (row.type === "case_stalled" && !entry.trigger.stalled) {
        entry.trigger.stalled = row.occurredAt;
      } else if (row.type === "deadline_expired" && !entry.trigger.deadline_expired) {
        entry.trigger.deadline_expired = row.occurredAt;
      } else if (row.type === "case_reminder_sent") {
        const reason = (row.payload as { reason?: unknown } | null)?.reason;
        if (typeof reason === "string" && (REMINDER_REASONS as readonly string[]).includes(reason)) {
          const key = reason as ReminderReason;
          if (!entry.reminded[key]) entry.reminded[key] = row.occurredAt;
        }
      } else if (userActions.has(row.type) && !entry.lastAction) {
        entry.lastAction = row.occurredAt;
      }

      seen.set(row.caseId, entry);
    }

    for (const row of open) {
      try {
        const entry = seen.get(row.id);
        if (!entry) continue;

        // RF-185's suppression, applied before anything is composed.
        if (entry.lastAction && entry.lastAction >= suppressBefore) continue;

        // Newest reason first: a case that stalled *and* had a deadline
        // expire is reminded about the more recent thing, not both.
        const due = REMINDER_REASONS
          .map((reason) => ({ reason, at: entry.trigger[reason] }))
          .filter((candidate): candidate is { reason: ReminderReason; at: Date } => candidate.at !== undefined)
          .filter(({ reason, at }) => {
            const sent = entry.reminded[reason];
            // A reminder already sent *after* the trigger has been
            // delivered. One sent before it belongs to an earlier
            // occurrence of the same reason and does not count — a case can
            // stall more than once.
            return !sent || sent < at;
          })
          .sort((left, right) => right.at.getTime() - left.at.getTime())[0];

        if (!due) continue;

        const [user] = await db.select({ email: users.email }).from(users)
          .where(eq(users.id, row.userId));
        // `cases.user_id` is NOT NULL with a foreign key and `users.email`
        // is NOT NULL, so both halves of this are guaranteed by the schema
        // rather than by this check. It stays as a narrowing step for the
        // type, and it throws rather than skipping: a case whose owner has
        // no row is a broken foreign key, not a person to be quietly passed
        // over, and A8 says a failure is visible. Per-case isolation below
        // keeps it to this one case.
        if (!user?.email) {
          throw new Error(`owner ${row.userId} has no e-mail; cases.user_id should make this impossible`);
        }

        const copy = COPY[due.reason];
        const caseUrl = `${appBaseUrl.replace(/\/+$/, "")}/caso/${row.id}`;

        await mailer.send({ to: user.email, subject: copy.subject, body: copy.body(caseUrl) });

        await db.insert(events).values({
          id: newId("evt"),
          caseId: row.id,
          userId: row.userId,
          invoiceId: row.invoiceId,
          type: "case_reminder_sent",
          payload: {
            reason: due.reason,
            // "email" and not "push": see the doc comment above. The field
            // exists now so E12 can add a value rather than a column.
            channel: "email",
            triggeredAt: due.at.toISOString(),
            stage: row.stage satisfies Stage,
          },
          occurredAt: now,
        });
      } catch (error) {
        // A8, and the same isolation `case-deadlines.ts` uses: one
        // unreachable mailbox must cost one reminder, not the whole run.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`case-reminders: case ${row.id} failed and was skipped: ${message}`);
      }
    }
  };
}
