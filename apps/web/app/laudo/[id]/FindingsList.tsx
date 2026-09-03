"use client";

import { useState } from "react";
import { formatCentsBRL } from "@pentefino/core";
import * as copy from "./copy.js";
import { sendFeedback } from "./feedback-client.js";
import styles from "./laudo.module.css";
import { confidenceLabel, removeById, type PendingQuestion, type ReportItem } from "./report-items.js";

/**
 * The only client component this screen needs (RNF-05): everything else -
 * totals, the empty state, needs_review - is static per render and ships
 * as server-rendered HTML with no JS. This one needs `useState` because
 * RF-143's acceptance is that feedback "removes the item from view"
 * without a full page reload, which needs client-held list state; there is
 * no server-component equivalent for that in this app today (no server
 * actions are wired up elsewhere in this route yet).
 *
 * `pendingId`/`errorId` key on the single item currently in flight, since
 * two feedback requests can never legitimately be in flight for the same
 * finding at once but different findings can be answered independently.
 */
export function FindingsList({
  initialFindings,
  initialQuestions,
}: {
  initialFindings: ReportItem[];
  initialQuestions: PendingQuestion[];
}) {
  const [findings, setFindings] = useState(initialFindings);
  const [questions, setQuestions] = useState(initialQuestions);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  async function handleDismiss(id: string) {
    setPendingId(id);
    setErrorId(null);
    const ok = await sendFeedback(id, "dismiss");
    setPendingId(null);
    if (!ok) {
      setErrorId(id);
      return;
    }
    setFindings((current) => removeById(current, id));
    setAnnouncement(copy.DISMISS_ANNOUNCEMENT);
  }

  async function handleAnswer(id: string, answer: string) {
    setPendingId(id);
    setErrorId(null);
    const ok = await sendFeedback(id, "confirm", answer);
    setPendingId(null);
    if (!ok) {
      setErrorId(id);
      return;
    }
    setQuestions((current) => removeById(current, id));
    setAnnouncement(copy.ANSWER_ANNOUNCEMENT);
  }

  return (
    <div>
      {/* Screen-reader equivalent of the item visually leaving the list -
          §13.3/RNF-09: a dynamic content change needs an announcement, not
          just a DOM node disappearing. */}
      <p aria-live="polite" className={styles.visuallyHidden}>{announcement}</p>

      {questions.length > 0 && (
        <section aria-labelledby="pending-questions-heading" className={styles.section}>
          <div className={styles.questionsPanel}>
            <h2 id="pending-questions-heading" className={styles.sectionHeading}>
              {copy.PENDING_QUESTIONS_HEADING}
            </h2>
            <p className={styles.questionsIntro}>{copy.PENDING_QUESTIONS_INTRO}</p>
            <ul className={styles.list}>
              {questions.map((item) => {
                const question = item.askUser?.question ?? copy.FALLBACK_QUESTION;
                const options = item.askUser?.options ?? copy.DEFAULT_YES_NO;
                const isPending = pendingId === item.id;
                return (
                  <li key={item.id} className={styles.questionCard}>
                    {item.evidence.length > 0 && <p className={styles.stepText}>{item.evidence.join(" ")}</p>}
                    <p className={styles.questionText}>{question}</p>
                    <div className={styles.answerActions}>
                      {options.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={styles.answerButton}
                          disabled={isPending}
                          onClick={() => handleAnswer(item.id, option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                    {isPending && <p role="status" className={styles.stepText}>{copy.ANSWER_LOADING}</p>}
                    {errorId === item.id && <p role="alert" className={styles.stepError}>{copy.FEEDBACK_ERROR}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      {findings.length > 0 && (
        <section aria-labelledby="findings-heading" className={styles.section}>
          <h2 id="findings-heading" className={styles.sectionHeading}>{copy.FINDINGS_HEADING}</h2>
          <ul className={styles.list}>
            {findings.map((item) => {
              const isAggregate = "aggregate" in item && item.aggregate === true;
              const label = confidenceLabel(item.band);
              const isPending = pendingId === item.id;
              return (
                <li key={item.id} className={styles.card}>
                  <div className={styles.cardTop}>
                    {label && (
                      <span className={`${styles.badge} ${item.band === "likely" ? styles.badgeLikely : styles.badgeVerify}`}>
                        {label}
                      </span>
                    )}
                    <p className={styles.evidence}>{item.evidence.join(" ")}</p>
                  </div>
                  <div className={styles.cardBottom}>
                    <div className={styles.amountGroup}>
                      <span>
                        <span className={styles.amountLabel}>{copy.AMOUNT_CHARGED_LABEL}: </span>
                        <span className={styles.amount}>{formatCentsBRL(item.amountCents)}</span>
                      </span>
                    </div>
                    {!isAggregate && (
                      <button
                        type="button"
                        className={styles.dismissButton}
                        disabled={isPending}
                        onClick={() => handleDismiss(item.id)}
                      >
                        {copy.DISMISS_BUTTON}
                      </button>
                    )}
                  </div>
                  {item.doubledCents ? (
                    <p className={styles.doubledInline}>{copy.doubledLine(formatCentsBRL(item.doubledCents))}</p>
                  ) : null}
                  {isPending && <p role="status" className={styles.stepText}>{copy.DISMISS_LOADING}</p>}
                  {errorId === item.id && <p role="alert" className={styles.stepError}>{copy.FEEDBACK_ERROR}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
