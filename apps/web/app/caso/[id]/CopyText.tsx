"use client";

import { useState } from "react";

/**
 * RF-183's copy half. `INV-002` is the whole point of this component: it
 * puts the text on the clipboard and stops. It sends nothing anywhere —
 * there is no fetch here, and the test
 * `apps/web/test/routes/caso-inv002.test.ts` asserts that by watching the
 * network surface, not by reading this comment.
 *
 * The person pastes it into the channel themselves. That is the product
 * boundary §1.5 draws, and it is what keeps this from being a service that
 * needs someone else's credentials.
 */
export function CopyText({ text, className }: { text: string; className?: string | undefined }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          // A denied clipboard permission is not an error worth a dialog —
          // the text is on screen and can be selected by hand.
          setCopied(false);
        }
      }}
    >
      {copied ? "Copiado" : "Copiar o texto"}
    </button>
  );
}
