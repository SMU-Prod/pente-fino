import * as copy from "./copy.js";
import styles from "./cobranca.module.css";

/**
 * Segment-level `not-found.tsx` (Next.js App Router convention), rendered
 * whenever `page.tsx` calls `notFound()`: an unknown issuer, an unknown
 * charge, a malformed slug and a row still in `draft` all land here,
 * indistinguishably — the same way `/l/[token]`'s own not-found refuses to
 * say whether a token never existed or was revoked.
 *
 * §13.3: every empty state is written, never a blank area. This is a
 * public, indexable route tree, so the one state that is by construction an
 * HTTP 404 is also the one a crawler is most likely to reach from a stale
 * link — Next's default 404 page would answer it in the wrong voice and the
 * wrong language.
 */
export default function ChargeNotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.accessState}>
        <p className={styles.empty}>{copy.NOT_FOUND_MESSAGE}</p>
        <a className={styles.backLink} href="/">{copy.BACK_HOME}</a>
      </div>
    </main>
  );
}
