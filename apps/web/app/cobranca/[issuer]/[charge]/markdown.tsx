import { Fragment } from "react";
import { SEO_FAQ_HEADING, SEO_PROVENANCE_HEADING, type SeoFaqEntry, type SeoSection } from "@pentefino/core";
import styles from "./cobranca.module.css";

/**
 * Turns Task 1's parsed `SeoPageContent` blocks into React elements.
 *
 * **There is no markdown library here, and there is no
 * `dangerouslySetInnerHTML` anywhere in this renderer.** That is the whole
 * point of `parseSeoContent`'s deliberately tiny grammar (see its own
 * module doc): the format is exactly `## ` headings, `### ` headings and
 * blank-line-separated paragraphs, which maps onto `<h2>`, `<h3>` and `<p>`
 * with nothing left over to interpret. Every string below is a text child,
 * so React escapes it — a page whose text happens to contain `<b>` renders
 * the characters `<b>`, and there is no path by which editorial content
 * becomes markup. A markdown library would reintroduce exactly that path
 * (and, for RNF-05, several kilobytes of client-irrelevant parser) in
 * exchange for syntax this corpus does not use.
 *
 * `FaqJsonLd` below does not use one either — see its own note, and the
 * test that pins the behaviour it depends on.
 */

export function SeoSections({ sections }: { sections: readonly SeoSection[] }) {
  return (
    <>
      {sections.map((section, index) => (
        <section className={styles.section} key={`${index}-${section.heading}`}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex}>{paragraph}</p>
          ))}
        </section>
      ))}
    </>
  );
}

/**
 * The FAQ block, under `SEO_FAQ_HEADING` — the same constant the seed
 * writes and the parser looks for, so the visible heading and the block
 * boundary can never drift apart.
 *
 * Renders nothing at all for an empty `faq`. A page with no questions is a
 * valid page (`SeoPageContent` says so), and an empty "Perguntas
 * frequentes" heading would be both a §13.3 empty area and an invitation
 * for the JSON-LD below to claim a `FAQPage` with no questions in it.
 */
export function SeoFaq({ faq }: { faq: readonly SeoFaqEntry[] }) {
  if (faq.length === 0) return null;
  return (
    <section className={styles.section}>
      <h2>{SEO_FAQ_HEADING}</h2>
      {faq.map((entry, index) => (
        <Fragment key={`${index}-${entry.question}`}>
          <h3>{entry.question}</h3>
          <p>{entry.answer}</p>
        </Fragment>
      ))}
    </section>
  );
}

/**
 * CLAUDE.md §7.0's disclosure, always last, on the page's one `--deep`
 * surface (§13.1's "seção de confiança"). Its heading is
 * `SEO_PROVENANCE_HEADING`, for the same reason the FAQ's is a constant.
 */
export function SeoProvenance({ text }: { text: string }) {
  return (
    <section className={styles.provenance}>
      <h2>{SEO_PROVENANCE_HEADING}</h2>
      <p>{text}</p>
    </section>
  );
}

// --- JSON-LD -------------------------------------------------------------

export type FaqPageJsonLd = {
  "@context": "https://schema.org";
  "@type": "FAQPage";
  mainEntity: Array<{
    "@type": "Question";
    name: string;
    acceptedAnswer: { "@type": "Answer"; text: string };
  }>;
};

/**
 * schema.org's `FAQPage`, built as a plain value.
 *
 * RF-283's acceptance — and §18's "pronto quando" for this whole block — is
 * "validação de rich results passa", and this object is what that check
 * reads. One `Question` per entry, **in the corpus's own order**, each with
 * an `acceptedAnswer` of type `Answer`: that is the shape Google documents
 * for an FAQ rich result, and any deviation (a bare string answer, a
 * `mainEntity` that is not an array, a missing `@type`) is silently dropped
 * rather than reported.
 *
 * Building a value and serialising it separately, rather than assembling a
 * string, is not a style choice: see `serializeJsonLd`.
 */
export function faqPageJsonLd(faq: readonly SeoFaqEntry[]): FaqPageJsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

/**
 * `JSON.stringify`, plus the one escape a `<script>` body needs.
 *
 * `JSON.stringify` is what makes the payload correct: it quotes, escapes
 * and encodes every string in the value, so a quotation mark, a backslash
 * or a line break inside an answer cannot break the JSON. String
 * concatenation cannot do that — it would need to re-derive JSON's own
 * escaping rules, and the first answer containing a `"` would produce a
 * payload no validator can read.
 *
 * What `JSON.stringify` does *not* do is care about HTML. Its output is
 * placed inside a `<script>` element, and an HTML parser ends that element
 * at the first `</script` sequence in its text, wherever it appears —
 * inside a JSON string included. React does not escape it either: measured
 * against React 19's own renderers, a `<` inside a `<script>` reaches the
 * output verbatim. So every `<` is re-encoded here as the JSON escape
 * sequence for it, which a JSON reader turns back into exactly the same
 * character and which an HTML parser cannot read as the start of a tag at
 * all. That is the whole escape: `<` is the only character that can begin
 * `</script` or `<!--`, so escaping it is sufficient, and it is applied to
 * the serialised text (not to the values) so no call site can forget it.
 *
 * Load-bearing, not defensive: with the `replace` removed, an answer
 * containing `</script><script>…</script>` really does close the tag and
 * put a live script in the page. That was watched failing before this line
 * was trusted (`test/cobranca/page.test.ts`).
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The `FAQPage` block, or nothing when the page has no questions — a
 * `FAQPage` with an empty `mainEntity` is an invalid rich result, and
 * claiming a structure the page does not have is exactly what §18's gate
 * exists to catch.
 *
 * The payload is a plain text child, **not** `dangerouslySetInnerHTML` —
 * the idiom most JSON-LD snippets reach for, and one this route does not
 * need. React treats a `<script>`'s text as raw text: measured against
 * React 19's `renderToStaticMarkup` and `renderToString`, both forms emit
 * byte-identical output for the same payload, quotation marks and `<`
 * included. So the escaping that matters is entirely `serializeJsonLd`'s,
 * and this route can be free of the one API that can turn a string into
 * markup. `test/cobranca/page.test.ts` pins that behaviour: it asserts the
 * emitted payload is byte-identical to `serializeJsonLd`'s output, so a
 * React version that started escaping here would fail a test instead of
 * silently dropping the rich result §18's gate is about.
 */
export function FaqJsonLd({ faq }: { faq: readonly SeoFaqEntry[] }) {
  if (faq.length === 0) return null;
  return (
    <script type="application/ld+json">{serializeJsonLd(faqPageJsonLd(faq))}</script>
  );
}
