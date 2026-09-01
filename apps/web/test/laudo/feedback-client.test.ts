import { afterEach, describe, expect, it, vi } from "vitest";
import { sendFeedback } from "../../app/laudo/[id]/feedback-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendFeedback", () => {
  it("posts a dismiss action with no answer field at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await sendFeedback("fnd_1", "dismiss");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/findings/fnd_1/feedback", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });
  });

  it("posts a confirm action with the chosen answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await sendFeedback("fnd_2", "confirm", "Sim");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/findings/fnd_2/feedback",
      expect.objectContaining({ body: JSON.stringify({ action: "confirm", answer: "Sim" }) }),
    );
  });

  it("resolves false when the server rejects the request, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(sendFeedback("fnd_3", "dismiss")).resolves.toBe(false);
  });

  it("resolves false when the network call itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(sendFeedback("fnd_4", "dismiss")).resolves.toBe(false);
  });
});
