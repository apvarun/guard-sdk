import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { TokenLimitExceededError, guard } from "@guard-sdk/core";
import { createSQLiteBudgetStore, createSQLiteLogger } from "../src/index.ts";

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "guard-sdk-budget-"));
  return [dir, () => rm(dir, { recursive: true, force: true })] as const;
}

test("SQLite budget store persists cumulative usage across reopen", async () => {
  const [dir, cleanup] = await tempDir();
  const dbPath = join(dir, "budget.db");

  try {
    const store = await createSQLiteBudgetStore({ dbPath });
    store.add("user-1", { costUsd: 0.5, totalTokens: 100, calls: 1 });
    store.add("user-1", { costUsd: 0.25, totalTokens: 50, calls: 1 });
    expect(store.get("user-1")).toEqual({ costUsd: 0.75, totalTokens: 150, calls: 2 });
    store.close();

    // Reopen: the cumulative total should survive the restart.
    const reopened = await createSQLiteBudgetStore({ dbPath });
    expect(reopened.get("user-1")).toEqual({ costUsd: 0.75, totalTokens: 150, calls: 2 });
    expect(reopened.get("unknown")).toEqual({ costUsd: 0, totalTokens: 0, calls: 0 });
    reopened.close();
  } finally {
    await cleanup();
  }
});

test("SQLite budget store commit can reject without mutating", async () => {
  const [dir, cleanup] = await tempDir();
  const dbPath = join(dir, "budget.db");

  try {
    const store = await createSQLiteBudgetStore({ dbPath });
    store.add("user-1", { costUsd: 0, totalTokens: 0, calls: 1 });

    expect(
      store.commit(
        "user-1",
        { costUsd: 0, totalTokens: 0, calls: 1 },
        {
          rejectIfExceeded: { calls: 1 },
        },
      ),
    ).toEqual({
      snapshot: { costUsd: 0, totalTokens: 0, calls: 1 },
      rejected: true,
    });
    expect(store.get("user-1")).toEqual({ costUsd: 0, totalTokens: 0, calls: 1 });
    store.close();
  } finally {
    await cleanup();
  }
});

test("guard enforces per-user budgets backed by SQLite across runs", async () => {
  const [dir, cleanup] = await tempDir();
  const dbPath = join(dir, "budget.db");

  try {
    const budget = await createSQLiteBudgetStore({ dbPath });
    const config = { userId: "user-1", budget, maxUserTokens: 10 };

    await guard.run(async () => ({ usage: { total_tokens: 8 } }), config);
    await expect(
      guard.run(async () => ({ usage: { total_tokens: 8 } }), config),
    ).rejects.toBeInstanceOf(TokenLimitExceededError);

    // Both runs executed the underlying call (the second is blocked only on the
    // post-call check), so the actual spend of both is recorded: 8 + 8 = 16.
    expect(budget.get("user-1::total").totalTokens).toBe(16);
    budget.close();
  } finally {
    await cleanup();
  }
});

test("SQLite logger holds a burst within the bounded write queue", async () => {
  const [dir, cleanup] = await tempDir();
  const dbPath = join(dir, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath, maxPendingWrites: 500 });

    const writes = Array.from({ length: 200 }, (_, index) =>
      Promise.resolve(
        logger.log({
          runId: `run-${index}`,
          calls: 1,
          retries: 0,
          durationMs: 1,
          status: "success",
        }),
      ),
    );

    await expect(Promise.all(writes)).resolves.toBeDefined();
    logger.close();
  } finally {
    await cleanup();
  }
});

test("SQLite logger rejects writes beyond the queue bound", async () => {
  const [dir, cleanup] = await tempDir();
  const dbPath = join(dir, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath, maxPendingWrites: 5 });

    const writes = Array.from({ length: 50 }, (_, index) =>
      Promise.resolve(
        logger.log({
          runId: `run-${index}`,
          calls: 1,
          retries: 0,
          durationMs: 1,
          status: "success",
        }),
      ),
    );

    const results = await Promise.allSettled(writes);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    logger.close();
  } finally {
    await cleanup();
  }
});

test("SQLite budget store throws on use after close", async () => {
  const [dir, cleanup] = await tempDir();
  const dbPath = join(dir, "budget.db");

  try {
    const store = await createSQLiteBudgetStore({ dbPath });
    store.close();

    expect(() => store.get("k")).toThrow(/closed/);
    expect(() => store.add("k", { costUsd: 1, totalTokens: 1, calls: 1 })).toThrow(/closed/);
  } finally {
    await cleanup();
  }
});
