"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./admin.module.css";

/**
 * The activate/pause buttons on one `rules` row.
 *
 * There is no optimistic update here on purpose: `router.refresh()` re-runs
 * the server component, which re-reads `listRuleFamilies` — so what the
 * admin sees after clicking is what `activateRuleVersion`/`pauseRuleVersion`
 * actually committed, not a guess this component made about what they would
 * do. RF-301's whole point is an append-only, versioned history; showing a
 * state the database does not yet hold would be the one place in this panel
 * where that promise could quietly slip.
 */
export function RuleActions({ ruleId, status }: { ruleId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/rules/${ruleId}/activate`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Não foi possível ativar essa versão.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function pause() {
    if (!reason.trim()) {
      setError("Diga por que está pausando — a pausa fica registrada com esse motivo.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/rules/${ruleId}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Não foi possível pausar essa versão.");
        return;
      }
      setPausing(false);
      setReason("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className={styles.actionRow}>
        {status === "draft" && (
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={busy} onClick={activate}>
            Ativar (sombra)
          </button>
        )}
        {(status === "active" || status === "shadow") && !pausing && (
          <button type="button" className={`${styles.button} ${styles.buttonDanger}`} disabled={busy} onClick={() => setPausing(true)}>
            Pausar
          </button>
        )}
      </div>
      {pausing && (
        <div className={styles.inlineForm}>
          <input
            className={styles.textInput}
            placeholder="Motivo da pausa"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="button" className={`${styles.button} ${styles.buttonDanger}`} disabled={busy} onClick={pause}>
            Confirmar pausa
          </button>
          <button type="button" className={styles.button} disabled={busy} onClick={() => { setPausing(false); setError(null); }}>
            Cancelar
          </button>
        </div>
      )}
      {error && <p className={styles.noticeError} role="alert">{error}</p>}
    </div>
  );
}
