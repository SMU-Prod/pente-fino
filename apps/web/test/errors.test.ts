import { describe, expect, it } from "vitest";
import { ERROR_CATALOGUE, apiError } from "../lib/errors.js";

describe("error catalogue", () => {
  it("covers exactly the seven codes of PRD §8.1", () => {
    expect(Object.keys(ERROR_CATALOGUE).sort()).toEqual([
      "extraction_failed", "file_too_large", "forbidden", "not_found",
      "quota_exceeded", "rate_limited", "unsupported_type",
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
