import type { Playbook } from "./playbook.js";

/**
 * PRD §20.2's reference telecom playbook, transcribed as written.
 *
 * Versioned configuration (A5), the way `EXTRACT_PROMPT_V1` and
 * `CONTEST_PROMPT_V1` are: the version lives in the identifier, a revision
 * of §20.2 arrives as `TELECOM_PLAYBOOK_V2` beside this one rather than as
 * an edit to it, and `packages/db/src/seeds/playbooks.ts` is what writes it
 * onto an `issuers` row. Unlike a prompt, though, the row it lands in has no
 * version of its own — `issuers.playbook` is a bare `jsonb` column, where
 * `prompts` has `(slug, version)`. So which version an issuer is running is
 * only recoverable by comparing its JSON against the constants here.
 *
 * **The `legalRefs` are load bearing.** RF-161 forbids E4's `assembleContest`
 * from inventing a legal reference; the ones a document may cite come from
 * data, and this is that data for telecom. Every `law`/`article` string here
 * is §20.2's, character for character.
 *
 * **What §20.2 does not contain**, though §9.1's machine routes to both:
 *
 *  - no **`ombudsman`** stage — §9.1 sends a `card` case there out of `sac`.
 *    No card issuer is seeded at all today (§20.1 is six telecom operators),
 *    so nothing routes there yet; the day one is, that issuer needs its own
 *    playbook with an `ombudsman` stage or the case will sit in a channel
 *    with no `responseDays`, no `asks` and no `channel` label to show.
 *  - no **`procon`** stage — which is not a gap. §9.1 marks `procon`
 *    *opcional*, and a playbook declaring the stage is exactly how the
 *    machine is told to route through it. §20.2 omitting it means a telecom
 *    case goes `regulator → jec_ready`, which is what §20.2 describes.
 *
 * Neither is filled in here. Inventing a channel, a deadline or a legal
 * reference the PRD does not state is the failure RF-161 exists to prevent,
 * and it would be indistinguishable from real configuration once seeded.
 */
export const TELECOM_PLAYBOOK_V1: Playbook = {
  stages: [
    {
      stage: "sac",
      channel: "SAC da operadora",
      responseDays: 7,
      businessDays: false,
      requiresPreviousProtocol: false,
      asks: [
        "número de protocolo",
        "suspensão imediata da cobrança contestada",
        "envio do histórico da demanda em 5 dias",
        "cópia da gravação do atendimento",
      ],
      legalRefs: [
        { law: "Decreto 11.034/2022", article: "art. 13 e §3º", effect: "suspensao" },
        { law: "Decreto 11.034/2022", article: "art. 12, §2º e §3º", effect: "limite" },
      ],
    },
    {
      stage: "consumidor_gov",
      channel: "consumidor.gov.br",
      deepLink: "https://www.consumidor.gov.br/pages/reclamacao/abrir",
      responseDays: 10,
      businessDays: false,
      requiresPreviousProtocol: true,
      asks: [
        "estorno em dobro com correção",
        "cancelamento com efeito imediato",
      ],
      legalRefs: [
        { law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" },
      ],
    },
    {
      stage: "regulator",
      channel: "Anatel",
      responseDays: 5,
      businessDays: true,
      requiresPreviousProtocol: true,
      asks: [
        "cobrança apenas da parte incontroversa",
        "novo boleto sem custo",
        "devolução em dobro",
      ],
      legalRefs: [
        { law: "Res. Anatel 765/2023", article: "arts. 60 a 62", effect: "suspensao" },
        { law: "Res. Anatel 765/2023", article: "art. 64", effect: "dobro" },
      ],
    },
    {
      stage: "jec_ready",
      channel: "Juizado Especial Cível",
      responseDays: 0,
      businessDays: false,
      requiresPreviousProtocol: true,
      asks: ["dossiê cronológico completo"],
      legalRefs: [],
    },
  ],
};
