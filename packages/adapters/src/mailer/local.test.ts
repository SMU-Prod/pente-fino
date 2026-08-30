import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalMailer } from "./local.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-mail-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("local mailer", () => {
  it("writes a message to disk with the recipient and subject legible on a round trip", async () => {
    const mailer = createLocalMailer(root);
    await mailer.send({ to: "user@example.com", subject: "Sua fatura chegou", body: "Corpo da mensagem." });

    const files = readdirSync(root);
    expect(files).toHaveLength(1);
    const [file] = files;
    if (!file) throw new Error("expected a message file to have been written");

    const content = readFileSync(join(root, file), "utf8");
    expect(content).toContain("To: user@example.com");
    expect(content).toContain("Subject: Sua fatura chegou");
    expect(content).toContain("Corpo da mensagem.");
  });

  it("does not let two messages sent in the same millisecond overwrite each other", async () => {
    const mailer = createLocalMailer(root);

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        mailer.send({ to: `user${i}@example.com`, subject: `Subject ${i}`, body: `Body ${i}` })),
    );

    const files = readdirSync(root);
    expect(files).toHaveLength(25);
  });

  it("creates the destination directory when it does not exist yet", async () => {
    const nested = join(root, "nested", "mail-dir");
    const mailer = createLocalMailer(nested);
    await mailer.send({ to: "user@example.com", subject: "Hi", body: "Body" });
    expect(readdirSync(nested)).toHaveLength(1);
  });

  it("rejects a \"to\" containing a line feed instead of writing an injected header", async () => {
    const mailer = createLocalMailer(root);
    await expect(
      mailer.send({ to: "user@example.com\nBcc: attacker@evil.com", subject: "Hi", body: "Body" }),
    ).rejects.toThrow(/"to"/);
    expect(readdirSync(root)).toHaveLength(0);
  });

  it("rejects a subject containing a carriage return + line feed instead of shifting where the body starts", async () => {
    const mailer = createLocalMailer(root);
    await expect(
      mailer.send({ to: "user@example.com", subject: "Hi\r\n\r\nInjected body", body: "Body" }),
    ).rejects.toThrow(/"subject"/);
    expect(readdirSync(root)).toHaveLength(0);
  });
});
