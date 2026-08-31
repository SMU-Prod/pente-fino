import { sql } from "drizzle-orm";
import { issuers } from "../schema.js";
import type { Database } from "../client.js";
import { newId } from "@pentefino/core";

/**
 * The telecom issuers of PRD §20.1, with the section names each one puts
 * its add-on charges under. Those section names are what E2's pattern
 * rules anchor on, so they are carried on the issuer row now via the
 * `sections` column (see the migration that added it) rather than left for
 * E2 to bolt on later — nothing is deployed yet, so the migration is free.
 *
 * `cnpj` is null for all six: the PRD does not state any of them, and a
 * guessed CNPJ would make issuer detection confidently wrong — exactly
 * what RF-106 exists to prevent. Detection falls back to alias matching
 * until each issuer's real CNPJ is filled in from its first real invoice.
 */
const SEED = [
  {
    slug: "claro-movel",
    displayName: "Claro Móvel",
    cnpj: null,
    aliases: ["Claro", "Claro S.A."],
    sections: ["Aplicativos Digitais"],
  },
  {
    slug: "vivo-movel",
    displayName: "Vivo",
    cnpj: null,
    aliases: ["Vivo", "Telefônica Brasil"],
    sections: [
      "Serviços Digitais",
      "Serviços Digitais avulsos",
      "Cobrança de Serviços de terceiros",
      "Adicionais Contratados",
    ],
  },
  {
    slug: "tim-movel",
    displayName: "TIM",
    cnpj: null,
    aliases: ["TIM", "TIM S.A."],
    sections: ["Serviços de valor adicionado(SVA)"],
  },
  {
    slug: "oi",
    displayName: "Oi",
    cnpj: null,
    aliases: ["Oi", "Oi Móvel"],
    sections: ["Serviços Digitais", "Outros Pacotes e Serviços Mensais"],
  },
  {
    slug: "sky",
    displayName: "Sky",
    cnpj: null,
    aliases: ["Sky", "SKY Brasil"],
    sections: ["lançamentos diversos"],
  },
  {
    slug: "algar",
    displayName: "Algar",
    cnpj: null,
    aliases: ["Algar", "Algar Telecom"],
    sections: ["Outros Valores", "SERVICOS FACILIDADES", "OUTRAS COBRANCAS"],
  },
] as const;

export async function seedIssuers(db: Database): Promise<void> {
  for (const entry of SEED) {
    await db
      .insert(issuers)
      .values({
        id: newId("iss"),
        slug: entry.slug,
        category: "telecom",
        displayName: entry.displayName,
        cnpj: entry.cnpj,
        aliases: [...entry.aliases],
        sections: [...entry.sections],
        playbook: null,
        status: "active",
      })
      .onConflictDoUpdate({
        target: issuers.slug,
        set: {
          displayName: entry.displayName,
          aliases: [...entry.aliases],
          sections: [...entry.sections],
          updatedAt: sql`now()`,
        },
      });
  }
}
