import type { Database } from "@pentefino/db";
import {
  createFixtureAiProvider, createInProcessQueue, createLocalMailer, createLocalStorage, type TaskHandler,
} from "@pentefino/adapters";
import { createIngestTask } from "@pentefino/jobs";

/**
 * Builds the exact same shape `lib/container.ts`'s `container()` returns,
 * wired to a real PGlite test database and real (local-filesystem) adapters
 * instead of whatever the environment would select. Route tests mock
 * `../../lib/container.js` and return this from it, so every route under
 * test still exercises its real code path end to end - `withUser`, the
 * in-process queue's idempotency-key dedupe, and the real ingest task - only
 * the "which database/credentials does the environment select" seam is
 * swapped out.
 */
export function buildTestContainer(options: {
  db: Database;
  storageRoot: string;
  mailRoot: string;
  fixtures?: Record<string, unknown>;
}) {
  const { db, storageRoot, mailRoot, fixtures = {} } = options;
  const handlers: Record<string, TaskHandler> = {};
  const storage = createLocalStorage({ root: storageRoot, secret: "test-upload-secret" });
  const ai = createFixtureAiProvider(fixtures);
  const queue = createInProcessQueue(handlers);
  const mailer = createLocalMailer(mailRoot);
  handlers.ingest = createIngestTask({ db, storage, ai });
  return { db, storage, queue, ai, mailer };
}
