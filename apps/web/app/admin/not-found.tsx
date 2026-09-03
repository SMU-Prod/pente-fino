import styles from "./admin.module.css";

/**
 * Segment-level `not-found.tsx` (Next.js App Router convention), rendered
 * whenever `page.tsx` calls `notFound()`.
 *
 * That happens for every rejection `requireAdmin` can produce — no session,
 * an unclaimed session, a soft-deleted account, or an e-mail off the
 * `ADMIN_EMAILS` roster — and this page renders identically for all of them,
 * as a real HTTP 404. `requireAdmin`'s own doc comment gives the reasoning:
 * a 403 would confirm this surface exists to anyone who merely finds the
 * URL, and there is nothing to gain from telling a stranger apart from an
 * admin whose session expired.
 */
export default function AdminNotFound() {
  return (
    <main className={styles.page}>
      <p className={styles.empty}>Não encontramos essa página.</p>
      <a href="/">Voltar para o início</a>
    </main>
  );
}
