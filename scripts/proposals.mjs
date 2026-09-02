#!/usr/bin/env node
// scripts/proposals.mjs
//
// Lists pending `agent_proposals` and applies one, by hand, from a
// terminal.
//
// ---------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------
//
// RF-126 promotes a `shadow` rule to `active` only through a proposal a
// human decides. `createRuleLifecycleTask` writes the proposal;
// `applyRulePromotionProposal` applies it. Until this script, nothing
// anywhere could call the second half: it is not exported from
// `@pentefino/jobs`'s barrel and no route, job or CLI reached it, so the
// only caller in the repo was its own test.
//
// The practical consequence was not small. Every detection rule this
// product has enters `shadow` when activated (RF-125) and stays there,
// writing findings nobody is shown, until a human promotes it. With no
// way to promote, that "until" never arrives — the rules engine runs, the
// findings accumulate with `shadow=true`, and the report stays empty
// forever. The engine would have looked healthy in every test and shown a
// user nothing.
//
// `createRuleLifecycleTask`'s doc comment names this deliberately and
// names the three ways out: "reachable only by reading `agent_proposals`
// directly (SQL, a script, a REPL)". This is the script. RF-300's admin
// panel (block E11) is the real surface and this does not pre-empt it —
// there is no listing UI here, no audit view, no queue. It is the manual
// path the author said would be the manual path.
//
// ---------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------
//
//   pnpm proposals                      list every pending proposal
//   pnpm proposals list --all           include already-decided ones
//   pnpm proposals approve <id> --by <who> [--reason "<text>"]
//
// `--by` is required for an approval and is written to
// `agent_proposals.decided_by`. A promotion that cannot say who decided it
// is not a decision, it is an anonymous flip of a rule that will start
// showing text to real people — §18's quality bar ("leitura manual de cada
// descarte") assumes a person, and this records which one.
//
// Runs against `DATABASE_URL`. Outside production `getUnscopedDb` falls
// back to a local PGlite database (see packages/db/src/client.ts), so this
// is safe to run locally against nothing.

import { register } from "node:module";

// See ts-sibling-loader.mjs's own header for why this hook is needed: the
// TypeScript sources this script imports use ".js" extensions on relative
// imports that no build step ever produces.
register("./ts-sibling-loader.mjs", import.meta.url);

const { getUnscopedDb, schema } = await import("../packages/db/src/index.ts");
const { applyRulePromotionProposal } = await import("../apps/jobs/src/tasks/rule-lifecycle.ts");

const { agentProposals } = schema;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function formatProposal(row) {
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const lines = [
    `${row.id}  [${row.status}]  ${row.kind}`,
    `  criada em   ${row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)}`,
  ];
  if (row.decidedBy) lines.push(`  decidida por ${row.decidedBy}`);
  if (row.payload && typeof row.payload === "object") {
    lines.push(`  payload     ${JSON.stringify(row.payload)}`);
  }
  for (const item of evidence) lines.push(`  evidência   ${String(item)}`);
  return lines.join("\n");
}

// Reads the whole table and filters in JS rather than importing
// `drizzle-orm`'s `eq`/`desc`: the package is a dependency of
// `packages/db`, not of the workspace root this script runs from, and
// `agent_proposals` is a table a human decides row by row - it does not
// reach a size where this matters, and RF-126 caps it further by refusing
// to write a second pending proposal for a rule that already has one.
async function list(db, includeDecided) {
  const all = await db.select().from(agentProposals);
  const rows = (includeDecided ? all : all.filter((row) => row.status === "pending"))
    .sort((left, right) => Number(new Date(right.createdAt)) - Number(new Date(left.createdAt)));

  if (rows.length === 0) {
    // The empty case says what it means, rather than printing nothing and
    // letting silence read as "everything is approved".
    console.log(
      includeDecided
        ? "Nenhuma proposta registrada. Nenhuma regra jamais foi promovida por este caminho."
        : "Nenhuma proposta pendente.\n" +
            "Isso significa que nenhuma regra em shadow atingiu o limiar da RF-126\n" +
            "(30+ disparos com descarte abaixo de 15%) desde a última execução do job\n" +
            "de ciclo de vida — não que não haja regra em shadow.",
    );
    return;
  }
  for (const row of rows) console.log(formatProposal(row), "\n");
  console.log(`${rows.length} proposta(s).`);
}

async function approve(db, proposalId, decidedBy, decisionReason) {
  await applyRulePromotionProposal({ db }, { proposalId, decidedBy, decisionReason });
  const row = (await db.select().from(agentProposals)).find((candidate) => candidate.id === proposalId);
  console.log(`Proposta ${proposalId} aplicada.`);
  console.log(formatProposal(row));
  console.log(
    "\nA regra está ativa: os achados dela passam a aparecer no laudo.\n" +
      "RF-127 continua valendo — se o descarte passar de 15% em 50+ disparos,\n" +
      "o job de ciclo de vida pausa a regra sozinho.",
  );
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "list";
  const db = getUnscopedDb();

  if (command === "list") {
    await list(db, flags.all === true);
    return;
  }

  if (command === "approve") {
    const proposalId = positional[1];
    if (!proposalId) throw new Error("uso: pnpm proposals approve <id> --by <quem> [--reason \"<texto>\"]");
    const decidedBy = typeof flags.by === "string" ? flags.by : undefined;
    if (!decidedBy) {
      throw new Error(
        "--by é obrigatório: uma promoção que não sabe dizer quem decidiu não é uma decisão.",
      );
    }
    const decisionReason = typeof flags.reason === "string" ? flags.reason : undefined;
    await approve(db, proposalId, decidedBy, decisionReason);
    return;
  }

  throw new Error(`comando desconhecido "${command}" — use "list" ou "approve"`);
}

// `import.meta.main` is not available on the Node versions this repo
// targets; comparing argv[1] is the same check every other script here
// makes.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("proposals.mjs");
if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { parseArgs, formatProposal, list, approve, main };
