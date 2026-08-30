export type TaskQueue = {
  enqueue(
    task: string,
    payload: Record<string, unknown>,
    opts?: { idempotencyKey?: string },
  ): Promise<{ runId: string; deduplicated: boolean }>;
};
