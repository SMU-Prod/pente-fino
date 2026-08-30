import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@pentefino/core";
import type { Mailer } from "@pentefino/core/ports";

const CR_OR_LF = /[\r\n]/;

/**
 * Writes each message to its own file so the e-mail code path is exercised
 * without calling Resend. The file name is a fresh random id, not a
 * timestamp, so two messages sent within the same millisecond still land in
 * two different files instead of one overwriting the other.
 *
 * `to` and `subject` are interpolated straight into the raw header block, so
 * a carriage return or line feed in either would write an extra
 * header-shaped line into the `.eml`, or (for subject) push a blank line
 * that shifts where a reader sees the body begin - classic header
 * injection. Resend's real API would reject or encode such input, so this
 * stand-in rejects it too rather than silently accepting what the real
 * adapter will not.
 */
export function createLocalMailer(root: string): Mailer {
  return {
    async send({ to, subject, body }) {
      if (CR_OR_LF.test(to)) {
        throw new Error(`mailer: "to" must not contain a carriage return or line feed: ${JSON.stringify(to)}`);
      }
      if (CR_OR_LF.test(subject)) {
        throw new Error(
          `mailer: "subject" must not contain a carriage return or line feed: ${JSON.stringify(subject)}`,
        );
      }

      mkdirSync(root, { recursive: true });
      const file = join(root, `${newId("evt")}.eml`);
      writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${body}\n`, "utf8");
    },
  };
}
