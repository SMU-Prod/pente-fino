"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./home.module.css";
import { uploadInvoice, UploadError, type UploadStep } from "./upload-client.js";

/**
 * The only interactive part of the front door, and therefore the only part
 * that ships JavaScript.
 *
 * `page.tsx` used to be a client component in its entirety, which put the
 * hero, the three steps and the footnote through hydration for no reason.
 * Lighthouse read that as an LCP of 2.4 s against RNF-03's 2.0 s budget:
 * 81% of it was *render delay* — the main thread busy with script — not
 * network. Everything static went back to the server; this stayed.
 *
 * `laudo/[id]` had already drawn the same line with `<FindingsList>`; this
 * is that pattern, not a new one.
 *
 * Every wait shows a named step (§13.3 rules out a mute spinner), so the
 * local upload steps and the server's own SSE steps share one vocabulary
 * and one bar — the person watches the same progress from "preparando"
 * through "analisando" without the screen changing under them.
 */

const STEP_LABEL: Record<string, string> = {
  preparing: "Preparando o arquivo",
  hashing: "Calculando a impressão digital",
  uploading: "Enviando",
  classifying: "Identificando o emissor",
  extracting: "Lendo a fatura",
  validating: "Conferindo os totais",
  done: "Pronto",
  needs_review: "Precisa de uma olhada",
  failed: "Falhou",
};

const LOCAL_PCT: Record<string, number> = { preparing: 4, hashing: 8, uploading: 14, queued: 18 };

export function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);

  const busy = step !== null && !error;

  const start = useCallback(async (file: File) => {
    setError(null);
    setPct(0);
    try {
      const id = await uploadInvoice(file, (s: UploadStep) => {
        setStep(s.kind);
        setPct(LOCAL_PCT[s.kind] ?? 0);
      });
      setInvoiceId(id);
    } catch (caught) {
      const message = caught instanceof UploadError
        ? caught.message
        : "Algo deu errado no envio. Tente de novo.";
      setError({ title: "Não deu para enviar", body: message });
      setStep(null);
    }
  }, []);

  // RF-141: the server's own progress, over SSE, from the moment the
  // pipeline has an invoice to report on. The stream closes itself on a
  // terminal step; the report page is where `done` lands.
  useEffect(() => {
    if (!invoiceId) return;
    const source = new EventSource(`/api/invoices/${invoiceId}/status`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as { step: string; progressPct: number };
      setStep(data.step);
      setPct(data.progressPct);
      if (data.step === "done" || data.step === "needs_review") {
        source.close();
        router.push(`/laudo/${invoiceId}`);
      }
      if (data.step === "failed") {
        source.close();
        setStep(null);
        setError({
          title: "Não consegui ler essa fatura",
          body: "O arquivo subiu, mas a leitura não foi adiante. Tente o PDF original, se você tiver.",
        });
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [invoiceId, router]);

  return (
    <>
      <input
        ref={inputRef}
        className={styles.fileInput}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/heic"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void start(file);
        }}
      />

      <button
        type="button"
        className={`${styles.drop} ${dragging ? styles.dropActive : ""}`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void start(file);
        }}
      >
        <p className={styles.dropTitle}>
          {busy ? "Trabalhando na sua fatura…" : "Escolher a fatura, ou arrastar até aqui"}
        </p>
        <p className={styles.dropHint}>
          PDF ou foto · até 15 MB e 12 páginas · <code>PDF JPG PNG HEIC</code>
        </p>
      </button>

      {busy && (
        <div className={styles.progress} role="status" aria-live="polite">
          <p className={styles.progressStep}>{STEP_LABEL[step] ?? step}</p>
          <span className={styles.progressTrack}>
            <span className={styles.progressBar} style={{ width: `${pct}%` }} />
          </span>
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>{error.title}</p>
          <p className={styles.errorBody}>{error.body}</p>
        </div>
      )}
    </>
  );
}
