import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route runs system-wide jobs with no user session, so what matters
// here is the door, not the work: who is let in, who is refused, and
// whether a failed job is visible. The handlers themselves are tested in
// `apps/jobs`.
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/cron/[task]/route.js");

const SECRET = "cron-secret-for-tests";

let enqueue: ReturnType<typeof vi.fn>;

function request(authorization?: string) {
  return new Request("https://example.test/api/cron/expireFiles", {
    headers: authorization ? { authorization } : {},
  });
}

function params(task: string) {
  return { params: Promise.resolve({ task }) };
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  enqueue = vi.fn().mockResolvedValue({ runId: "run_test", deduplicated: false });
  vi.mocked(container).mockReturnValue({ queue: { enqueue } } as never);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.restoreAllMocks();
});

describe("GET /api/cron/:task — the door", () => {
  it("runs the task for a caller with the right bearer token", async () => {
    const response = await GET(request(`Bearer ${SECRET}`), params("expireFiles"));
    expect(response.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith("expireFiles", {});
  });

  it("refuses a wrong token, and does not run the task", async () => {
    const response = await GET(request("Bearer wrong-secret-same-len"), params("expireFiles"));
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a caller with no Authorization header at all", async () => {
    const response = await GET(request(), params("expireFiles"));
    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a token of a different length rather than throwing", async () => {
    // `timingSafeEqual` throws on a length mismatch. If the length check
    // were missing, this would surface as an unhandled error — and an
    // error path is itself a signal about the secret's length.
    const response = await GET(request("Bearer short"), params("expireFiles"));
    expect(response.status).toBe(401);
  });

  // The failure that matters most: a deploy that forgets CRON_SECRET must
  // not fall open. Anonymous access here means a stranger can expire
  // someone's uploaded invoice.
  it("refuses EVERY request when CRON_SECRET is not configured, rather than falling open", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request(), params("expireFiles"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "cron_not_configured" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("still refuses when CRON_SECRET is unset even if the caller presents a token", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request("Bearer anything"), params("expireFiles"));
    expect(response.status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/:task — the allowlist", () => {
  it.each(["caseDeadlines", "expireFiles", "ruleMetrics", "ruleLifecycle"])(
    "schedules %s",
    async (task) => {
      const response = await GET(request(`Bearer ${SECRET}`), params(task));
      expect(response.status).toBe(200);
      expect(enqueue).toHaveBeenCalledWith(task, {});
    },
  );

  // `ingest` is a registered handler that belongs to a user's upload and
  // takes an invoiceId. Without an allowlist this route would be a way to
  // start any registered task by guessing its name.
  it("refuses `ingest`, which is registered but is not scheduled work", async () => {
    const response = await GET(request(`Bearer ${SECRET}`), params("ingest"));
    expect(response.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a task name nothing registers", async () => {
    const response = await GET(request(`Bearer ${SECRET}`), params("../../etc/passwd"));
    expect(response.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/:task — a failed job is visible (A8)", () => {
  it("answers 500 when the handler throws, so a nightly failure is not silence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.mockRejectedValue(new Error("storage unreachable"));

    const response = await GET(request(`Bearer ${SECRET}`), params("expireFiles"));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "task_failed", task: "expireFiles" });
  });

  it("says so when no handler is registered, instead of reporting success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.mockRejectedValue(new Error('no handler registered for task "caseDeadlines"'));

    const response = await GET(request(`Bearer ${SECRET}`), params("caseDeadlines"));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("no handler registered") });
  });
});
