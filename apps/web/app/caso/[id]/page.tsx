import { cookies } from "next/headers";
import { assembleContest, STAGES, type Stage } from "@pentefino/core";
import { resolveSession, withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";
import { CopyText } from "./CopyText.js";
import styles from "./caso.module.css";

/**
 * RF-183's screen: where a person sees the state of their own case and does
 * the next step.
 *
 * A server component, like `laudo/[id]`: it reads the session cookie and
 * goes through `withUser` (INV-008) rather than fetching its own JSON route
 * over HTTP. Another user's case and a case that does not exist produce the
 * same screen, because `caseDetail` folds ownership into the query and
 * returns `null` for both.
 *
 * **`INV-002` is what this page is shaped around.** It offers a deep link
 * and a copy button. It does not send. Nothing on this page performs a
 * request to a channel, on the server or in the browser — the only client
 * code here is `<CopyText>`, which writes to the clipboard and stops.
 */

const STAGE_LABEL: Record<Stage, string> = {
  draft: "Rascunho",
  sac: "SAC",
  ombudsman: "Ouvidoria",
  consumidor_gov: "consumidor.gov",
  regulator: "Agência",
  procon: "Procon",
  jec_ready: "Juizado",
  closed: "Encerrado",
};

const EVENT_LABEL: Record<string, string> = {
  case_created: "Caso aberto",
  contest_generated: "Texto da contestação gerado",
  contest_edited: "Você editou o texto",
  contest_marked_sent: "Você marcou como enviado",
  protocol_entered: "Protocolo registrado",
  stage_advanced: "Caso avançou de etapa",
  deadline_expired: "Prazo venceu",
  case_stalled: "Caso parado, sem protocolo",
  case_viewed: "Você abriu o caso",
  outcome_confirmed: "Desfecho registrado",
  case_reopened: "Caso reaberto",
};

const DATE = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

/** Whole days between now and a deadline; negative once it has passed. */
function daysUntil(deadline: Date, now: Date): number {
  return Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);
}

function AccessState({ message }: { message: string }) {
  return <main className={styles.accessState}>{message}</main>;
}

export default async function CasoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, getSessionSecret()) : null;
  if (!sessionId) {
    return <AccessState message="Abra este caso no mesmo navegador em que você enviou a fatura." />;
  }

  const { db } = container();
  // `resolveSession`, not `withUser({ sessionId })` directly: `cases.userId`
  // is NOT NULL, so an unclaimed anonymous session owns no case and every
  // case-scoped read would come back empty. A case is only reachable once
  // the session has been claimed by a real user (RF-140 / §8.2's claim
  // flow), and this is where that translation happens.
  const scoped = withUser(await resolveSession(sessionId, db), db);
  const detail = await scoped.caseDetail(id);
  if (!detail) {
    return <AccessState message="Não encontramos este caso." />;
  }

  const { case: kase, documents, protocols, timeline } = detail;
  const issuer = await scoped.issuerForInvoice(kase.invoiceId);
  const playbook = issuer?.playbook ?? { stages: [] };
  const stagePlaybook = playbook.stages.find((entry) => entry.stage === kase.stage);

  // RF-165's checklist comes from `assembleContest`, the same function the
  // document generator uses — not a second list that could disagree with the
  // one printed on the letter the person is about to send.
  const assembled = assembleContest({
    findings: [],
    stage: kase.stage,
    playbook,
    protocols: protocols.map((p) => ({
      stage: p.stage,
      protocolNumber: p.protocolNumber,
      channel: p.channel,
      registeredAt: p.registeredAt,
    })),
  });

  const now = new Date();
  const remaining = kase.nextDeadlineAt ? daysUntil(kase.nextDeadlineAt, now) : null;
  const latest = documents.at(-1);
  const documentText = latest ? (latest.editedBody ?? latest.body) : null;
  const currentIndex = STAGES.indexOf(kase.stage);

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>Seu caso</p>
      <h1 className={styles.heading}>
        {issuer?.displayName ?? "Sua operadora"} · {STAGE_LABEL[kase.stage]}
      </h1>

      <ol className={styles.ladder}>
        {STAGES.filter((stage) => stage !== "draft" && stage !== "closed").map((stage) => {
          const index = STAGES.indexOf(stage);
          const className = stage === kase.stage
            ? `${styles.rung} ${styles.rungCurrent}`
            : index < currentIndex
              ? `${styles.rung} ${styles.rungDone}`
              : styles.rung;
          return <li key={stage} className={className}>{STAGE_LABEL[stage]}</li>;
        })}
      </ol>

      {kase.nextDeadlineAt && remaining !== null && (
        <section className={styles.deadline}>
          <p className={styles.deadlineLabel}>
            {remaining < 0 ? "Prazo vencido" : "Prazo para resposta"}
          </p>
          <p className={`${styles.deadlineValue} ${remaining < 0 ? styles.deadlineLate : ""}`}>
            {DATE.format(kase.nextDeadlineAt)}
          </p>
          <p className={styles.deadlineNote}>
            {remaining < 0
              ? `Venceu há ${Math.abs(remaining)} ${Math.abs(remaining) === 1 ? "dia" : "dias"}. Você já pode levar o caso para a próxima etapa.`
              : `Faltam ${remaining} ${remaining === 1 ? "dia" : "dias"}. Se não responderem até lá, o caso avança sozinho.`}
          </p>
        </section>
      )}

      {stagePlaybook && (
        <section className={styles.action}>
          <p className={styles.actionLabel}>Próximo passo</p>
          <p className={styles.actionChannel}>{stagePlaybook.channel}</p>

          <div className={styles.actionRow}>
            {stagePlaybook.deepLink ? (
              <a
                className={styles.linkButton}
                href={stagePlaybook.deepLink}
                target="_blank"
                rel="noreferrer noopener"
              >
                Abrir o canal
              </a>
            ) : null}
            {documentText ? (
              <CopyText
                className={styles.copyButton}
                text={[
                  documentText.subject,
                  "",
                  documentText.body,
                  "",
                  ...documentText.requests.map((request) => `- ${request}`),
                ].join("\n")}
              />
            ) : null}
          </div>

          {!stagePlaybook.deepLink && (
            <p className={styles.noLink}>
              Este canal não tem um endereço direto — procure por “{stagePlaybook.channel}”
              no site ou no aplicativo da empresa.
            </p>
          )}

          {assembled.attachmentsChecklist.length > 0 && (
            <>
              <p className={styles.checklistTitle}>Leve junto</p>
              <ul className={styles.checklist}>
                {assembled.attachmentsChecklist.map((item) => (
                  <li key={item} className={styles.checklistItem}>
                    <span className={styles.checkBox} aria-hidden="true">[ ]</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Protocolos</h2>
        {protocols.length === 0 && (
          <p className={styles.empty}>Nenhum protocolo registrado ainda.</p>
        )}
        {protocols.map((protocol) => (
          <div key={protocol.id} className={styles.row}>
            <p className={styles.rowMain}>
              {protocol.channel} · nº {protocol.protocolNumber}
            </p>
            <p className={styles.rowMeta}>
              {DATE.format(protocol.registeredAt)} → {DATE.format(protocol.responseDueAt)}
            </p>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Documentos</h2>
        {documents.length === 0 && (
          <p className={styles.empty}>Nenhum texto gerado ainda.</p>
        )}
        {documents.map((document) => (
          <div key={document.id} className={styles.row}>
            <p className={styles.rowMain}>
              {(document.editedBody ?? document.body).subject}
            </p>
            <p className={styles.rowMeta}>
              {STAGE_LABEL[document.stage]}
              {document.userEdited ? " · editado por você" : ""}
              {document.sentAt ? ` · enviado em ${DATE.format(document.sentAt)}` : ""}
            </p>
          </div>
        ))}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Linha do tempo</h2>
        <ol className={styles.timeline}>
          {timeline.map((event) => (
            <li key={event.id} className={styles.timelineItem}>
              <p className={styles.timelineWhen}>{DATE_TIME.format(event.occurredAt)}</p>
              <p className={styles.timelineWhat}>{EVENT_LABEL[event.type] ?? event.type}</p>
            </li>
          ))}
        </ol>
        {timeline.length === 0 && <p className={styles.empty}>Ainda sem histórico.</p>}
      </section>

      <p className={styles.footnote}>
        Nada é enviado por nós. O botão copia o texto e abre o canal; quem
        escreve e quem envia é você, no seu nome.
      </p>
    </main>
  );
}
