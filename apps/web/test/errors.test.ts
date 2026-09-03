import { describe, expect, it } from "vitest";
import { ERROR_CATALOGUE, apiError } from "../lib/errors.js";

describe("error catalogue", () => {
  // PRD §8.1's seven codes, plus the two E11 Task 4 added for the admin
  // panel's HTTP surface (`rule_invalid`, `proposal_conflict`) — §8.1's own
  // catalogue has no admin-facing entry, since the admin panel did not exist
  // when it was written.
  it("covers exactly the seven codes of PRD §8.1 plus block E11's two admin codes", () => {
    expect(Object.keys(ERROR_CATALOGUE).sort()).toEqual([
      "extraction_failed", "file_too_large", "forbidden", "not_found",
      "proposal_conflict", "quota_exceeded", "rate_limited", "rule_invalid", "unsupported_type",
    ]);
  });

  it("maps file_too_large to 413 with the pt-BR message", async () => {
    const response = apiError("file_too_large");
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.message).toContain("15 MB");
  });

  it("shapes the body as { error: { code, message } }", async () => {
    const body = await apiError("not_found").json();
    expect(body).toEqual({ error: { code: "not_found", message: "Não encontramos esse item." } });
  });
});
