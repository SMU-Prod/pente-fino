import * as copy from "./copy.js";
import styles from "./laudo.module.css";

/**
 * RF-144's own screen. A server component - nothing here is interactive,
 * so it ships no client JS at all. Deliberately does not touch
 * `report.findings` or `report.totals`: the A8 principle as a screen is
 * that a partially-read invoice never gets a partially-assembled report,
 * so this component's props are its own message and nothing from the
 * report, on purpose - there is no prop that could leak a partial finding
 * in here even by a future accident.
 *
 * The layout (centered, generous whitespace, a single soft device) is
 * deliberately not the ledger-row layout the normal report uses below, so
 * this never reads as a thinner or broken version of that screen - it is
 * its own honest state.
 */
export function NeedsReview() {
  return (
    <main className={styles.page}>
      <div className={styles.needsReviewWrap} role="status">
        <div className={styles.blurredPhoto} aria-hidden="true" />
        <p className={styles.needsReviewMessage}>{copy.NEEDS_REVIEW_MESSAGE}</p>
        <a className={styles.ctaButton} href="/">
          {copy.NEEDS_REVIEW_CTA}
        </a>
      </div>
    </main>
  );
}
