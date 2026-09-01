import * as copy from "./copy.js";
import styles from "./public.module.css";

/**
 * Segment-level `not-found.tsx` (Next.js App Router convention): rendered
 * whenever `page.tsx` calls `notFound()` - a missing token, a revoked one,
 * or one whose invoice is not `analyzed` yet all land here, indistinguishably
 * (RF-146's acceptance treats "revoked" and "never existed" the same way
 * `/laudo/[id]`'s own `ITEM_NOT_FOUND` does for another session's invoice).
 *
 * §13.3: every empty state is written, never a blank area - even the one
 * state on this whole route that is, by construction, an HTTP 404.
 */
export default function PublicLaudoNotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.accessState}>
        <p className={styles.empty}>{copy.NOT_FOUND_MESSAGE}</p>
        <a className={styles.backLink} href="/">{copy.BACK_HOME}</a>
      </div>
    </main>
  );
}
