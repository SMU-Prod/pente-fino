import { DOWNLOAD_TTL_MS } from "@pentefino/adapters";

/**
 * Every pt-BR string `GET /api/me/export` (RF-242, Task 4, E8) can produce,
 * in one place - `test/routes/me-export.test.ts` asserts every one of them
 * against `lintUserFacingText` (INV-004/INV-005), the same pattern
 * `app/laudo/[id]/copy.ts` established for that screen.
 *
 * Code and comments are English; every exported value is the pt-BR text a
 * person actually reads.
 */

const DOWNLOAD_TTL_MINUTES = Math.round(DOWNLOAD_TTL_MS / 60_000);

/**
 * The top-level `aviso` field on the export payload. Computed from the
 * storage adapter's own `DOWNLOAD_TTL_MS` rather than a hand-typed number,
 * so this sentence can never drift out of sync with how long a link in the
 * `files` array actually stays valid (`packages/adapters/src/storage/local.ts`).
 *
 * Says plainly that the links expire and roughly when, and nothing else:
 * no promise about what happens after, no legal vocabulary (§14.3) - the
 * rows themselves (`account`, `invoices`, ...) are the permanent record;
 * only the *links* pointing at stored files are short-lived.
 */
export const AVISO =
  `Os links de download deste arquivo valem por ${DOWNLOAD_TTL_MINUTES} minutos a partir de agora. ` +
  "Depois disso, peça um novo export para baixar os arquivos de novo.";
