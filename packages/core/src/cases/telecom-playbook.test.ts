import { describe, expect, it } from "vitest";
import { STAGES, type Stage } from "./playbook.js";
import { TELECOM_PLAYBOOK_V1 } from "./telecom-playbook.js";

function entry(stage: Stage) {
  return TELECOM_PLAYBOOK_V1.stages.find((candidate) => candidate.stage === stage);
}

describe("TELECOM_PLAYBOOK_V1 · PRD §20.2, transcribed", () => {
  it("carries §20.2's four stages, in §20.2's order", () => {
    expect(TELECOM_PLAYBOOK_V1.stages.map((s) => s.stage))
      .toEqual(["sac", "consumidor_gov", "regulator", "jec_ready"]);
  });

  it("declares only stages the `cases_stage_values` constraint accepts", () => {
    const declared = TELECOM_PLAYBOOK_V1.stages.map((s) => s.stage);
    expect(declared.filter((stage) => !(STAGES as readonly string[]).includes(stage))).toEqual([]);
  });

  it("gives `sac` seven calendar days and §20.2's four asks", () => {
    expect(entry("sac")).toMatchObject({
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
    });
  });

  it("gives `consumidor_gov` ten calendar days and RF-183's deep link", () => {
    expect(entry("consumidor_gov")).toMatchObject({
      channel: "consumidor.gov.br",
      deepLink: "https://www.consumidor.gov.br/pages/reclamacao/abrir",
      responseDays: 10,
      businessDays: false,
      requiresPreviousProtocol: true,
    });
  });

  it("gives `regulator` five BUSINESS days — the one stage §20.2 counts that way", () => {
    // RF-181's acceptance is a business-day deadline, and this is the only
    // playbook row that produces one. A transcription that flipped this flag
    // would make every Anatel deadline land early and the whole business-day
    // calendar unreachable from real data.
    expect(entry("regulator")).toMatchObject({
      channel: "Anatel", responseDays: 5, businessDays: true,
    });
    const businessDayStages = TELECOM_PLAYBOOK_V1.stages
      .filter((stage) => stage.businessDays).map((stage) => stage.stage);
    expect(businessDayStages).toEqual(["regulator"]);
  });

  it("gives `jec_ready` zero response days — filing with a court is not a wait", () => {
    expect(entry("jec_ready")).toMatchObject({
      channel: "Juizado Especial Cível", responseDays: 0, requiresPreviousProtocol: true,
    });
  });

  it("carries §20.2's legal references verbatim — RF-161 forbids inventing them", () => {
    expect(entry("sac")?.legalRefs).toEqual([
      { law: "Decreto 11.034/2022", article: "art. 13 e §3º", effect: "suspensao" },
      { law: "Decreto 11.034/2022", article: "art. 12, §2º e §3º", effect: "limite" },
    ]);
    expect(entry("consumidor_gov")?.legalRefs).toEqual([
      { law: "CDC", article: "art. 42, parágrafo único", effect: "dobro" },
    ]);
    expect(entry("regulator")?.legalRefs).toEqual([
      { law: "Res. Anatel 765/2023", article: "arts. 60 a 62", effect: "suspensao" },
      { law: "Res. Anatel 765/2023", article: "art. 64", effect: "dobro" },
    ]);
    expect(entry("jec_ready")?.legalRefs).toEqual([]);
  });

  it("declares no `ombudsman` and no `procon`, because §20.2 declares neither", () => {
    // Not an oversight, and not to be filled in from imagination: §9.1 sends
    // a `card` case to `ombudsman`, and no card issuer exists to route
    // (§20.1 seeds six telecom operators). `procon` being absent is what
    // makes §9.1's optional Procon step optional for telecom.
    expect(entry("ombudsman")).toBeUndefined();
    expect(entry("procon")).toBeUndefined();
  });

  it("has a deep link only where §20.2 states one (RF-183 shows no invented URL)", () => {
    const withLinks = TELECOM_PLAYBOOK_V1.stages
      .filter((stage) => stage.deepLink !== undefined).map((stage) => stage.stage);
    expect(withLinks).toEqual(["consumidor_gov"]);
  });
});
