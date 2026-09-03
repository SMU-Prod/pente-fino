"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./admin.module.css";

type LegalRow = { law: string; article: string; effect: string; note: string };

const CATEGORIES = ["telecom", "card", "energy", "water"] as const;
const KINDS = ["pattern", "delta", "threshold", "reference", "confirm", "arithmetic", "suppressor"] as const;
const EFFECTS = ["dobro", "suspensao", "cancelamento", "amostra_gratis", "vedada", "limite"] as const;

/**
 * One worked `spec` per kind, loaded verbatim from the same fixtures
 * `packages/core/src/rules/draft.test.ts` uses to prove `validateRuleDraft`
 * accepts them. `RuleSpec` is a seven-way discriminated union owned by
 * `packages/core` (see `apps/web/app/api/admin/rules/route.ts`'s own doc
 * comment on why this form does not re-type it as seven sets of dedicated
 * inputs) — a form built from a *second* description of that union would
 * drift the moment a field is added there and not here. A JSON editor,
 * seeded with a real example per kind, asks the admin to edit a shape that
 * is already known to validate, rather than assemble one from scratch.
 */
const SPEC_TEMPLATES: Record<(typeof KINDS)[number], string> = {
  pattern: JSON.stringify({ kind: "pattern", match: "SVA|SEGURO" }, null, 2),
  delta: JSON.stringify(
    { kind: "delta", field: "amount", comparedTo: "previous_invoice", changeAtLeastPct: 10 }, null, 2,
  ),
  threshold: JSON.stringify({ kind: "threshold", expr: "total_amount", operator: ">", value: 100 }, null, 2),
  reference: JSON.stringify({ kind: "reference", source: "aneel_tariff", tolerancePct: 5 }, null, 2),
  confirm: JSON.stringify(
    { kind: "confirm", question: "O valor cobrado bate com o contrato?", options: ["sim", "nao"], onNo: "create_finding" },
    null, 2,
  ),
  arithmetic: JSON.stringify(
    { kind: "arithmetic", formula: "base * aliquota", expect: "valor_total", tolerancePct: 1 }, null, 2,
  ),
  suppressor: JSON.stringify(
    { kind: "suppressor", blocks: ["(?=.*\\bICMS\\b)(?=.*\\bTUSD\\b)"], reason: "Tese morta (Tema 986/STJ)." },
    null, 2,
  ),
};

type Problem = { field: string; code: string; message: string };

/**
 * RF-301's "editar cria versão nova": this form only ever `POST`s a new
 * draft, on `slug`, and never patches a `rules` row in place — that
 * discipline lives entirely server-side (`createRuleVersion`), so nothing
 * here needs to enforce it, but nothing here offers an "edit" action either.
 */
export function NewRuleForm() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("telecom");
  const [issuerId, setIssuerId] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("pattern");
  const [spec, setSpec] = useState(SPEC_TEMPLATES.pattern);
  const [legal, setLegal] = useState<LegalRow[]>([]);
  const [confidenceBase, setConfidenceBase] = useState("0.7");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function loadTemplate(nextKind: (typeof KINDS)[number]) {
    setKind(nextKind);
    setSpec(SPEC_TEMPLATES[nextKind]);
  }

  function addLegalRow() {
    setLegal((rows) => [...rows, { law: "", article: "", effect: EFFECTS[0], note: "" }]);
  }

  function updateLegalRow(index: number, patch: Partial<LegalRow>) {
    setLegal((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeLegalRow(index: number) {
    setLegal((rows) => rows.filter((_, i) => i !== index));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setProblems([]);
    setGenericError(null);
    setSuccess(null);

    let parsedSpec: unknown;
    try {
      parsedSpec = JSON.parse(spec);
    } catch {
      setGenericError("O spec não é um JSON válido.");
      return;
    }

    const confidence = Number(confidenceBase);
    if (!Number.isFinite(confidence)) {
      setGenericError("A confiança base precisa ser um número.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          category,
          issuerId: issuerId.trim() === "" ? null : issuerId.trim(),
          kind,
          spec: parsedSpec,
          legalBasis: legal.map((row) => ({
            law: row.law,
            article: row.article,
            effect: row.effect,
            ...(row.note.trim() ? { note: row.note.trim() } : {}),
          })),
          confidenceBase: confidence,
          reason,
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | { id: string; slug: string; version: number }
        | { error: { code: string; message: string; details?: Problem[] } }
        | null;

      if (!response.ok) {
        if (body && "error" in body) {
          setGenericError(body.error.message);
          if (Array.isArray(body.error.details)) setProblems(body.error.details);
        } else {
          setGenericError("Não foi possível criar essa versão da regra.");
        }
        return;
      }

      if (body && "slug" in body) {
        setSuccess(`Criada: ${body.slug} v${body.version}, em draft.`);
        setSlug("");
        setIssuerId("");
        setLegal([]);
        setReason("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.newRuleForm} onSubmit={submit}>
      <div className={styles.templateRow}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={styles.templateButton}
            onClick={() => loadTemplate(k)}
            aria-pressed={kind === k}
          >
            {k}
          </button>
        ))}
      </div>

      {genericError && <p className={styles.noticeError}>{genericError}</p>}
      {success && <p className={styles.noticeOk}>{success}</p>}
      {problems.length > 0 && (
        <ul className={styles.errorList}>
          {problems.map((problem, i) => (
            <li key={i}>
              <strong>{problem.field}</strong>: {problem.message}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.fieldRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Slug</span>
          <input
            className={styles.textInput}
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Categoria</span>
          <select
            className={styles.selectInput}
            value={category}
            onChange={(event) => setCategory(event.target.value as (typeof CATEGORIES)[number])}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Emissor (vazio = genérica)</span>
          <input
            className={styles.textInput}
            value={issuerId}
            onChange={(event) => setIssuerId(event.target.value)}
            placeholder="issuerId, opcional"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Confiança base (0–1)</span>
          <input
            className={styles.textInput}
            required
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={confidenceBase}
            onChange={(event) => setConfidenceBase(event.target.value)}
          />
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Tipo (kind): {kind}</span>
        <textarea
          className={styles.textArea}
          required
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          spellCheck={false}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Base legal</span>
        {legal.map((row, i) => (
          <div key={i} className={styles.legalRow}>
            <input
              className={styles.textInput}
              placeholder="Lei (ex.: CDC)"
              value={row.law}
              onChange={(event) => updateLegalRow(i, { law: event.target.value })}
            />
            <input
              className={styles.textInput}
              placeholder="Artigo"
              value={row.article}
              onChange={(event) => updateLegalRow(i, { article: event.target.value })}
            />
            <select
              className={styles.selectInput}
              value={row.effect}
              onChange={(event) => updateLegalRow(i, { effect: event.target.value })}
            >
              {EFFECTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <button type="button" className={styles.button} onClick={() => removeLegalRow(i)}>Remover</button>
          </div>
        ))}
        <button type="button" className={styles.button} onClick={addLegalRow}>Adicionar referência legal</button>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Motivo da criação (fica no histórico)</span>
        <textarea
          className={styles.textArea}
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>

      <button type="submit" className={`${styles.button} ${styles.buttonPrimary}`} disabled={busy}>
        {busy ? "Enviando…" : "Criar versão (draft)"}
      </button>
    </form>
  );
}
