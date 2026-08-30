import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../../src/schema.js";

const BANNED = /^(commission|success_?fee|percent)/i;

describe("INV-001 · never charge a percentage of what the user recovers", () => {
  it("has no commission-shaped column anywhere in the schema", () => {
    const offenders: string[] = [];
    for (const [name, table] of Object.entries(schema)) {
      if (typeof table !== "object" || table === null) continue;
      let columns: Record<string, { name: string }>;
      try { columns = getTableColumns(table as never); } catch { continue; }
      for (const column of Object.values(columns)) {
        if (BANNED.test(column.name)) offenders.push(`${name}.${column.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
