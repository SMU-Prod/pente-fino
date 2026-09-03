import { notFound } from "next/navigation";
// eslint-disable-next-line pentefino/require-with-user -- rules and proposals are system configuration, not one user's data (packages/db/src/admin.ts's own header); this page has no session to scope any of the three by withUser, the same reasoning apps/web/app/api/admin/*/route.ts already carries.
import { adminOverview, listProposals, listRuleFamilies } from "@pentefino/db";
import { requireAdmin } from "@/lib/admin.js";
import { container } from "@/lib/container.js";
import { NewRuleForm } from "./NewRuleForm.js";
import { ProposalActions } from "./ProposalActions.js";
import { RuleActions } from "./RuleActions.js";
import styles from "./admin.module.css";

/**
 * RF-300's overview and rule catalogue, RF-304's approval queue, RF-301's
 * rule creation — one page, because a single admin going through their
 * morning does not need three separate screens for three views of the same
 * small set of rules and proposals.
 *
 * `requireAdmin` is called here, server-side, before anything below reads a
 * row — a non-admin never receives the data this page renders, only
 * `notFound()`. That mirrors every route in `app/api/admin/*`: a 403 would
 * confirm the surface exists to anyone who finds the URL, so every
 * rejection (`requireAdmin`'s own doc comment lists them) looks like a page
 * that was never there.
 *
 * The three sections read fresh on every request; the client islands
 * (`RuleActions`, `ProposalActions`, `NewRuleForm`) call `router.refresh()`
 * after a write instead of updating local state, so what an admin sees
 * after clicking is what the database actually committed.
 *
 * **`dynamic = "force-dynamic"` is not a performance knob here — it is the
 * fix for a real bug this exact commit shipped.** Unlike `/laudo/[id]` and
 * `/caso/[id]`, this route has no dynamic path segment, so Next.js's
 * default behaviour is to try to *prerender it once at build time* and
 * serve that same static HTML to every visitor. `container()` calls
 * `getUnscopedDb()` before this function ever reaches a dynamic API
 * (`cookies()`, inside `requireAdmin`), so in a build environment with no
 * `DATABASE_URL` — exactly CI, and exactly what caught this — the build
 * fails loudly. That is the *good* outcome. The bad one, which this
 * directive also rules out, is a CI environment where `DATABASE_URL`
 * happens to be reachable at build time: Next would have gladly baked one
 * admin's overview and rule list into a static page served to every future
 * visitor regardless of their own session — or cached `notFound()` for
 * everyone if the build-time render had none. `force-dynamic` makes every
 * request re-run `requireAdmin` for real, the way `apps/web/app/api/
 * cron/[task]/route.ts` already forces the same thing for the same reason.
 */
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { db } = container();
  const admin = await requireAdmin(db);
  if (!admin) notFound();

  const now = new Date();
  const [overview, families, proposals] = await Promise.all([
    adminOverview(db, { now }),
    listRuleFamilies(db),
    listProposals(db, { includeDecided: false }),
  ]);

  const pillClass: Record<string, string> = {
    draft: styles.pillDraft ?? "",
    shadow: styles.pillShadow ?? "",
    active: styles.pillActive ?? "",
    paused: styles.pillPaused ?? "",
  };

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>Painel — {admin.email}</p>
      <h1 className={styles.heading}>Regras, propostas e o dia de hoje</h1>

      <h2 className={styles.sectionTitle}>Hoje</h2>
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <p className={styles.statLabel}>Faturas hoje</p>
          <p className={styles.statValue}>
            {Object.values(overview.invoicesToday).reduce((a, b) => a + b, 0)}
          </p>
          {Object.keys(overview.invoicesToday).length > 0 && (
            <p className={styles.statBreakdown}>
              {Object.entries(overview.invoicesToday).map(([k, v]) => `${k}: ${v}`).join(" · ")}
            </p>
          )}
        </div>
        <div className={styles.statCard}>
          <p className={styles.statLabel}>Custo de IA hoje</p>
          <p className={styles.statValue}>${overview.aiCostToday.costUsd.toFixed(4)}</p>
          <p className={styles.statBreakdown}>{overview.aiCostToday.calls} chamadas</p>
        </div>
        <div className={styles.statCard}>
          <p className={styles.statLabel}>Casos parados</p>
          <p className={styles.statValue}>{overview.stalledCases}</p>
        </div>
        <div className={styles.statCard}>
          <p className={styles.statLabel}>Achados em sombra</p>
          <p className={styles.statValue}>{overview.shadowFindings}</p>
        </div>
        <div className={styles.statCard}>
          <p className={styles.statLabel}>Páginas de SEO</p>
          <p className={styles.statValue}>
            {Object.values(overview.seoPages).reduce((a, b) => a + b, 0)}
          </p>
          {Object.keys(overview.seoPages).length > 0 && (
            <p className={styles.statBreakdown}>
              {Object.entries(overview.seoPages).map(([k, v]) => `${k}: ${v}`).join(" · ")}
            </p>
          )}
        </div>
      </div>

      <h2 className={styles.sectionTitle}>Propostas pendentes</h2>
      <p className={styles.sectionHint}>
        RF-126: uma regra em sombra com 30+ disparos e descarte abaixo de 15% chega aqui como
        proposta — ela não vira ativa sozinha. Aprovar aplica {"a"} promoção; rejeitar mantém a
        regra em sombra.
      </p>
      {proposals.length === 0 && <p className={styles.empty}>Nenhuma proposta pendente.</p>}
      {proposals.map((proposal) => (
        <div key={proposal.id} className={styles.family}>
          <div className={styles.familyHead}>
            <span className={styles.familySlug}>{proposal.kind} · alvo {proposal.target}</span>
            <span className={styles.pill}>{proposal.status}</span>
          </div>
          {Array.isArray(proposal.evidence) && proposal.evidence.length > 0 && (
            <p className={styles.versionSub}>{proposal.evidence.join(" · ")}</p>
          )}
          <ProposalActions proposalId={proposal.id} />
        </div>
      ))}

      <h2 className={styles.sectionTitle}>Regras</h2>
      <p className={styles.sectionHint}>
        Cada edição cria uma versão nova — a anterior fica como histórico, nunca é sobrescrita
        (RF-301).
      </p>
      {families.length === 0 && <p className={styles.empty}>Nenhuma regra ainda.</p>}
      {families.map((family) => (
        <div key={family.slug} className={styles.family}>
          <div className={styles.familyHead}>
            <span className={styles.familySlug}>{family.slug}</span>
          </div>
          {family.versions.map((version) => (
            <div key={version.id} className={styles.version}>
              <div className={styles.versionMeta}>
                <p className={styles.versionLine}>
                  v{version.version} · {version.kind} · {version.category}{" "}
                  <span className={`${styles.pill} ${pillClass[version.status] ?? ""}`}>{version.status}</span>{" "}
                  {version.hasPendingPromotionProposal && (
                    <span className={`${styles.pill} ${styles.pillPending}`}>proposta pendente</span>
                  )}
                </p>
                <p className={styles.versionSub}>
                  autor: {version.author} · {version.reason}
                </p>
                <p className={styles.metrics}>
                  disparos {version.metrics.fired} · descartes {version.metrics.dismissed} ·
                  confirmados {version.metrics.confirmed} · contestados {version.metrics.contested} ·
                  resolvidos {version.metrics.resolved}
                </p>
              </div>
              <RuleActions ruleId={version.id} status={version.status} />
            </div>
          ))}
        </div>
      ))}

      <h2 className={styles.sectionTitle}>Nova versão de regra</h2>
      <p className={styles.sectionHint}>
        Nasce em draft (RF-125). Ativar move para sombra por 7 dias — nada aparece no laudo até lá.
      </p>
      <NewRuleForm />
    </main>
  );
}
