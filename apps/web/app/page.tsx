"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./home.module.css";
import { uploadInvoice, UploadError, type UploadStep } from "./upload-client.js";

/**
 * The front door (§8.2's flow, §13.1's design language).
 *
 * Every wait shows a named step — §13.3 is explicit that a mute spinner is
 * not acceptable — so the local upload steps and the server's own SSE steps
 * share one vocabulary and one bar. The user watches the same progress from
 * "preparando" through "analisando" without the screen changing under them.
 *
 * Copy note: nothing here promises an outcome. §14.3's forbidden vocabulary
 * (INV-004/INV-005) rules out "garantimos", "você vai receber" and every
 * variant, and the product's own claim is deliberately narrow — it shows
 * what is worth checking, and the person decides.
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

export default function Home() {
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

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void start(file);
  };

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>Auditoria de fatura</p>

      <h1 className={styles.headline}>
        Sua conta tem linhas que{" "}
        <span className={styles.marked}>
          ninguém lê
          <svg
            className={styles.markedUnderline}
            viewBox="0 0 200 20"
            fill="none"
            aria-hidden="true"
            preserveAspectRatio="none"
          >
            <path
              d="M4 13c38-7 78-9 118-6 26 2 51 6 74 10"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
        .
      </h1>

      <p className={styles.lede}>
        Envie a fatura da sua operadora ou a do cartão. Em segundos você vê,
        linha por linha, o que vale conferir — com o valor de cada item e o
        motivo pelo qual ele apareceu.
      </p>

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
        onDrop={onDrop}
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

      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.stepNumber}>01</span>
          <h2 className={styles.stepTitle}>Você envia</h2>
          <p className={styles.stepBody}>
            O arquivo vai direto para o armazenamento, sem passar pelo nosso
            servidor. Não pedimos senha nem acesso à sua conta na operadora.
          </p>
        </li>
        <li className={styles.step}>
          <span className={styles.stepNumber}>02</span>
          <h2 className={styles.stepTitle}>A fatura é lida</h2>
          <p className={styles.stepBody}>
            Cada item é separado, somado e comparado com o ciclo anterior.
            CPF, endereço e código de barras são mascarados antes de gravar.
          </p>
        </li>
        <li className={styles.step}>
          <span className={styles.stepNumber}>03</span>
          <h2 className={styles.stepTitle}>Você decide</h2>
          <p className={styles.stepBody}>
            O laudo mostra o que vale conferir e por quê. Se você quiser
            contestar, o texto sai pronto no seu nome — quem envia é você.
          </p>
        </li>
      </ol>

      <p className={styles.footnote}>
        O arquivo enviado é apagado em 30 dias. Você não precisa criar conta
        para ver o laudo. Este produto não é escritório de cobrança e não
        recebe percentual de nada que você recuperar.
      </p>
    </main>
  );
}
