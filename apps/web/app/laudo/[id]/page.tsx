import { cookies } from "next/headers";
import { withUser } from "@pentefino/db";
import { container } from "@/lib/container.js";
import { formatCentsBRL, loadReport } from "@/lib/report.js";
import { SESSION_COOKIE, getSessionSecret, readSession } from "@/lib/session.js";
import { FindingsList } from "./FindingsList.js";
import * as copy from "./copy.js";
import styles from "./laudo.module.css";
import { NeedsReview } from "./needs-review.js";
import { splitReportItems } from "./report-items.js";

/**
 * RF-143/RF-144 (PRD §13.2's four required "Laudo" states: com achados,
 * sem achados, needs_review, com perguntas pendentes). A server component -
 * it reads the session cookie and the database directly (through
 * `withUser`, INV-008) the same way the JSON route does, rather than
 * fetching that route over HTTP from the server: this is the first render
 * of the page, there is no client yet to have made the request, and an SSR
 * self-fetch would just duplicate the same ownership check and JSON
 * round-trip for no benefit. `@/lib/report.js` is shared with
 * `GET /api/invoices/[id]/report` precisely so both read the same
 * classification/clustering logic instead of two copies that could drift.
 *
 * `report_viewed` is recorded here, not inside `loadReport`: viewing this
 * page is itself the "report was viewed" moment (the JSON route records
 * its own, for whoever calls it directly) - see the comment on
 * `loadReport` for why that stays a pure read.
 *
 * The only client-side interactivity on this whole screen - dismissing a
 * finding, answering a pending question - lives in `<FindingsList>`
 * (RNF-05: everything else here ships zero JS).
 */
export default async function LaudoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const secret = getSessionSecret();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? readSession(cookie, secret) : null;

  if (!sessionId) {
    return <AccessState message={copy.ACCESS_DENIED} />;
  }

  const { db } = container();
  const scoped = withUser({ sessionId }, db);
  const report = await loadReport(scoped, id);
  if (!report) {
    return <AccessState message={copy.ITEM_NOT_FOUND} />;
  }

  await scoped.recordEvent("report_viewed", {}, id);

  // RF-144/A8: an invoice the pipeline could not read gets its own honest
  // screen, full stop - `report.findings`/`report.totals` are never even
  // read below this line for this branch, so a partially-extracted row
  // cannot leak into a report that looks assembled.
  if (report.invoice.status === "needs_review") {
    return <NeedsReview />;
  }

  const { regular, questions } = splitReportItems(report.findings);
  const hasContent = regular.length > 0 || questions.length > 0;

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>{copy.HEADING}</p>
      <section aria-labelledby="totals-heading">
        <h1 id="totals-heading" className={styles.heading}>
          {copy.totalToVerifyLine(formatCentsBRL(report.totals.suspectCents))}
        </h1>
        <div className={styles.statRow}>
          <div className={styles.statCard}>
            <p className={styles.statLabel}>{copy.TOTAL_TO_VERIFY_LABEL}</p>
            <p className={styles.statValue}>
              <MarkedAmount>{formatCentsBRL(report.totals.suspectCents)}</MarkedAmount>
            </p>
          </div>
          {report.totals.doubledCents > 0 && (
            <div className={styles.statCard}>
              <p className={styles.statLabel}>{copy.TOTAL_DOUBLED_LABEL}</p>
              <p className={`${styles.statValue} ${styles.statValueDoubled}`}>
                {formatCentsBRL(report.totals.doubledCents)}
              </p>
            </div>
          )}
        </div>
      </section>

      {!hasContent && <p className={styles.empty}>{copy.EMPTY_STATE}</p>}

      {hasContent && <FindingsList initialFindings={regular} initialQuestions={questions} />}
    </main>
  );
}

function AccessState({ message }: { message: string }) {
  return (
    <main className={styles.page}>
      <div className={styles.accessState}>
        <p className={styles.empty}>{message}</p>
        <a className={styles.backLink} href="/">{copy.BACK_HOME}</a>
      </div>
    </main>
  );
}

/**
 * The design's one signature move: the headline number reads as if it had
 * been circled by hand on the printed bill, the way the person who found
 * this charge would have marked it themselves. `stroke="var(--mark)"` is
 * set inline on the SVG's own DOM node (not through a CSS background
 * image), so it resolves against whichever theme is active exactly like
 * any other themed color on the page.
 */
function MarkedAmount({ children }: { children: React.ReactNode }) {
  return (
    <span className={styles.markedAmount}>
      {children}
      <svg
        className={styles.markedAmountUnderline}
        viewBox="0 0 100 14"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M2 9 Q 15 3, 28 8 T 54 7 T 80 9 T 98 6"
          fill="none"
          stroke="var(--mark)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
