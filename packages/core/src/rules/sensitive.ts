// --- Vocabulary -------------------------------------------------------
//
// LGPD art. 5 II names five kinds of sensitive personal data; PRD.md §3's
// INV-006 repeats four of them verbatim: saúde (health), religião
// (religion), sindicato (union membership), política (political
// affiliation). Written in Brazilian Portuguese and matched
// accent-insensitively (see `stripAccents` below) because that is the
// language a real invoice or card statement is written in — an English
// list would pass every one of them and catch nothing.
//
// Entries are stems, not whole words, so one entry catches every inflected
// form a merchant description or an admin's free text is likely to use
// ("farmac" -> farmácia, farmacêutico, farmácias). Written without
// diacritics, since matching runs against accent-stripped text.
//
// Deliberately excluded: bare political-party acronyms (PT, PSDB, MDB...)
// and bare words that are common Portuguese surnames or unrelated
// vocabulary ("batista" is both a church denomination and one of the most
// common surnames in Brazil; "capela" is also a place name; "candidato" is
// routinely used for a job applicant, not just an electoral one). Each of
// those would flag an author's name or an unrelated rule far more often
// than it would ever flag a real violation. Where the sensitive sense only
// shows up combined with a second word ("igreja batista", "campanha
// eleitoral"), the multi-word phrase is listed instead of the ambiguous
// word alone.
type SensitiveCategory = "saude" | "religiao" | "sindicato" | "politica";

export const SENSITIVE_VOCABULARY: Record<SensitiveCategory, string[]> = {
  // Health (LGPD "dado referente a saude"): what a pharmacy, clinic,
  // hospital or health-plan charge actually looks like on a Brazilian card
  // statement or invoice line item.
  //
  // "clinic" and "ambulator" are truncated one letter shorter than the
  // whole-word forms `clinica`/`ambulatorio` would suggest, specifically so
  // the same stem covers both the noun and the adjective
  // (clínica/clínico, ambulatório/ambulatorial) — a whole-word stem would
  // silently miss whichever form did not end the same way.
  saude: [
    "saude", "farmac", "drogaria", "drogasil", "hospital", "clinic",
    "ambulator", "pronto socorro", "medic", "enferm", "psicolog",
    "psiquiatr", "fisioterap", "odontolog", "nutricion", "fonoaudiolog",
    "oncolog", "cancer", "hiv", "aids", "plano de saude",
    "unimed", "amil", "hapvida", "notredame",
  ],
  // Religion (LGPD "filiacao a organizacao de caracter religioso"):
  // denominations and giving vocabulary the way they read on a PIX or card
  // description ("DIZIMO", "IGREJA BATISTA"), not the bare theology term.
  religiao: [
    "igreja", "paroquia", "diocese", "arquidiocese", "catedral", "templo",
    "congregacao", "sinagoga", "mesquita", "umbanda", "candomble",
    "espirita", "dizimo", "dizimista", "catolic", "evangelic",
    "igreja batista", "assembleia de deus", "testemunha de jeova",
  ],
  // Union membership (LGPD "filiacao a sindicato"). Two stems, not one:
  // "sindicat" (sindicato/sindicatos) and "sindical" (sindical/
  // sindicalista/sindicalizado/mensalidade sindical — the noun and the
  // adjective diverge right after the shared "sindica-" root, so one stem
  // cannot cover both). A single shorter "sindica" stem would cover both
  // forms too, but it would also catch "sindicância" (an administrative
  // inquiry — unrelated to union membership); stopping one letter earlier,
  // at the fork, avoids that collision without losing either real form.
  sindicato: ["sindicat", "sindical"],
  // Political affiliation (LGPD "opiniao politica"). "partid" catches
  // partido/partidario/partidaria; bare party acronyms are excluded (see
  // header note above).
  politica: ["partid", "eleitoral"],
};

const ALL_SENSITIVE_TERMS = Object.values(SENSITIVE_VOCABULARY).flat();

// Non-capturing group: the whole match *is* the matched term, so no capture
// index is needed and there is nothing for `noUncheckedIndexedAccess` to
// complain about when reading `hit[0]`.
const SENSITIVE_TERM = new RegExp(`\\b(?:${ALL_SENSITIVE_TERMS.join("|")})`, "i");

// Unicode "Combining Diacritical Marks" block: NFD decomposition splits an
// accented letter like "ã" or "ê" into a plain letter followed by one of
// these combining marks. Named as code points (rather than written as a
// regex escape) to keep the exact characters unambiguous in source control.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;

/** Strips diacritics so e.g. `saúde` and `dízimo` still match their unaccented stems. */
function stripAccents(text: string): string {
  return Array.from(text.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code < COMBINING_MARKS_START || code > COMBINING_MARKS_END;
    })
    .join("");
}

/** The first sensitive term found in `text`, or null. Accent-insensitive. */
export function findSensitiveTerm(text: string): string | null {
  const hit = SENSITIVE_TERM.exec(stripAccents(text));
  return hit ? hit[0] : null;
}

/**
 * Every string value anywhere inside an arbitrary JSON-shaped value,
 * recursing into objects and arrays. `RuleSpec` is a closed union today
 * (pattern/delta/threshold/reference/confirm/arithmetic/suppressor), but
 * this walks the value structurally instead of switching on `kind`, so it
 * keeps working without changes if a future rule kind adds a free-text
 * field nobody thought to list here by name.
 */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}
