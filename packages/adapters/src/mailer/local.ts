import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@pentefino/core";
import type { Mailer } from "@pentefino/core/ports";

/**
 * Writes each message to its own file so the e-mail code path is exercised
 * without calling Resend. The file name is a fresh random id, not a
 * timestamp, so two messages sent within the same millisecond still land in
 * two different files instead of one overwriting the other.
 */
export function createLocalMailer(root: string): Mailer {
  return {
    async send({ to, subject, body }) {
      mkdirSync(root, { recursive: true });
      const file = join(root, `${newId("evt")}.eml`);
      writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${body}\n`, "utf8");
    },
  };
}
