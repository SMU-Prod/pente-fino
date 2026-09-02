import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route runs system-wide jobs with no user session, so what matters
// here is the door, not the work: who is let in, who is refused, and
// whether a failed job is visible. The handlers themselves are tested in
// `apps/jobs`.
vi.mock("../../lib/container.js", () => ({ container: vi.fn() }));

const { container } = await import("../../lib/container.js");
const { GET } = await import("../../app/api/cron/[task]/route.js");

const SECRET = "cron-secret-for-tests";

// Mirrors `SCHEDULABLE` in the route. Kept here rather than imported
// because the route does not export it, and a test that imported it could
// not notice the list being emptied.
const SCHEDULABLE_NAMES = ["expireFiles", "ruleMetrics", "ruleLifecycle", "caseDeadlines", "dossier"];

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
  it.each(SCHEDULABLE_NAMES)(
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

// =====================================================================
// The list that grows by merge
// =====================================================================

describe("SCHEDULABLE and container()'s handler map cannot drift apart", () => {
  // This guard exists because the drift already happened once, in the
  // merge that landed RF-187: the dossier handler was registered in
  // `container()` and not listed in `SCHEDULABLE`, which left it exactly
  // as dead as every job was before this route existed - registered,
  // tested, and never run by anything.
  //
  // Reading the source is deliberate. The handler map is local to
  // `buildContainer` and the queue only answers about a name you already
  // guessed, so there is no runtime way to ask "what is registered?".
  // A future task that adds `handlers.somethingNew` and forgets the
  // schedule fails here instead of shipping a job that never runs.
  const NOT_SCHEDULED: Record<string, string> = {
    // Enqueued by POST /api/invoices/:id/process, carries an invoiceId,
    // belongs to one person's upload. Never a cron.
    ingest: "started by a user's upload, not by a clock",
  };

  it("schedules, or explicitly excuses, every handler container() registers", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../lib/container.ts", import.meta.url), "utf8");
    const registered = [...source.matchAll(/handlers\.(\w+)\s*=/g)].map((m) => m[1]);

    expect(registered.length).toBeGreaterThan(0); // the regex still matches something

    const unaccounted = registered.filter(
      (name) => !SCHEDULABLE_NAMES.includes(name) && !(name in NOT_SCHEDULED),
    );
    expect(unaccounted).toEqual([]);
  });

  it("every scheduled name resolves to a handler, so no cron path hits nothing", async () => {
    for (const task of SCHEDULABLE_NAMES) {
      enqueue.mockClear();
      const response = await GET(request(`Bearer ${SECRET}`), params(task));
      expect(response.status, `${task} should be schedulable`).toBe(200);
    }
  });
});
