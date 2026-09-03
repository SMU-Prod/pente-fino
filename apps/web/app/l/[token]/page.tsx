import { notFound } from "next/navigation";
import { formatCentsBRL } from "@pentefino/core";
import { container } from "@/lib/container.js";
import * as copy from "./copy.js";
import { loadPublicReport } from "./data.js";
import styles from "./public.module.css";

/**
 * RF-146: the product's first surface reachable with no session at all - a
 * link a friend shared, opened with no cookie and no account. It reads its
 * data by `invoices.publicToken` alone (`loadPublicReport`, `data.ts`),
 * never by `withUser`; that is the deliberate `INV-008` exception this
 * whole route exists to be, mirroring RF-145's card (see
 * `apps/web/app/api/card/[token]/route.tsx`) for the identical access
 * question over the identical column.
 *
 * A missing, revoked, not-yet-analyzed or still-`needs_review` token all
 * call Next's own `notFound()` here, which serves a real HTTP 404 - the
 * same "wrong token and no token look identical" guarantee `loadPublicReport`
 * already builds into its own `WHERE` clause (RF-146's acceptance:
 * "returns 404 once the token is revoked").
 *
 * `data.ts`'s `PublicReport` type is this route's actual anonymisation
 * boundary: everything past `loadPublicReport` is a number the layout below
 * formats, plus `issuerLabel`, which `safeIssuerLabel` already ran through
 * `containsPii` before this component ever saw it. That is this page's
 * second gate (the first is the token/status `WHERE` clause) - there is no
 * further free text anywhere below to check, because none of the fields
 * that could carry it (item descriptions, section names, the period, the
 * due date) were ever selected in the first place.
 */
export default async function PublicLaudoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { db } = container();

  const report = await loadPublicReport(token, db);
  if (!report) notFound();

  const hasFindings = report.findingsCount > 0;

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>{copy.EYEBROW}</p>
      <p className={styles.issuerBadge}>{report.issuerLabel}</p>

      <h1 className={styles.heading}>
        {hasFindings
          ? copy.totalToVerifyLine(formatCentsBRL(report.suspectCents))
          : copy.CLEAN_REPORT_MESSAGE}
      </h1>

      {hasFindings && (
        <>
          <div className={styles.statRow}>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>{copy.TOTAL_TO_VERIFY_LABEL}</p>
              <p className={styles.statValue}>
                <MarkedAmount>{formatCentsBRL(report.suspectCents)}</MarkedAmount>
              </p>
            </div>
            {report.doubledCents > 0 && (
              <div className={styles.statCard}>
                <p className={styles.statLabel}>{copy.TOTAL_DOUBLED_LABEL}</p>
                <p className={`${styles.statValue} ${styles.statValueDoubled}`}>
                  {formatCentsBRL(report.doubledCents)}
                </p>
              </div>
            )}
          </div>
          {report.doubledCents > 0 && (
            // §14.2's mandatory sentence, verbatim - never "você tem direito
            // a receber". The stat card above already shows the doubled
            // figure beside the charged one (§13.3); this line is the
            // actual wording §14.2 requires when that legal basis applies.
            <p className={styles.doubledLine}>{copy.doubledLine(formatCentsBRL(report.doubledCents))}</p>
          )}
          <p className={styles.findingsLine}>{copy.findingsLine(report.findingsCount)}</p>
        </>
      )}

      <section className={styles.cta} aria-labelledby="cta-heading">
        <h2 id="cta-heading" className={styles.ctaHeading}>{copy.CTA_HEADING}</h2>
        <p className={styles.ctaBody}>{copy.CTA_BODY}</p>
        <a className={styles.ctaButton} href="/">{copy.CTA_BUTTON}</a>
      </section>
    </main>
  );
}

/**
 * The design's signature move, carried over from the private report: the
 * headline number reads as if it had been circled by hand on the printed
 * bill. Duplicated from `apps/web/app/laudo/[id]/page.tsx`'s own
 * `MarkedAmount` (same reasoning as this route's `copy.ts`/`data.ts`: a
 * small, presentational, non-exported helper duplicated across two
 * independently-evolving route folders rather than shared through a new
 * cross-route module).
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
