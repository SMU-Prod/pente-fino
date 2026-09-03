"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./admin.module.css";

/**
 * RF-304's decision: approve or reject one pending proposal.
 *
 * `reason` is required on both paths, matching the route it calls
 * (`POST /api/admin/proposals/:id`) — `applyRulePromotionProposal` types
 * `decisionReason` as a required string, and §18's "leitura manual de cada
 * descarte" bar is not satisfied by a decision with no reason attached to
 * it. This form cannot submit an empty one.
 */
export function ProposalActions({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (!reason.trim()) {
      setError("O motivo é obrigatório — fica registrado com a decisão.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/proposals/${proposalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Não foi possível aplicar essa decisão agora.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className={styles.inlineForm}>
        <input
          className={styles.textInput}
          placeholder="Motivo da decisão"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          disabled={busy}
          onClick={() => decide("approve")}
        >
          Aprovar
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonDanger}`}
          disabled={busy}
          onClick={() => decide("reject")}
        >
          Rejeitar
        </button>
      </div>
      {error && <p className={styles.noticeError} role="alert">{error}</p>}
    </div>
  );
}
