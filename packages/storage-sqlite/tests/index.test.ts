import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { expect, test } from "vite-plus/test";
import type { GuardUsage } from "@guard-sdk/core";
import { createSQLiteLogger, readUsageReport } from "../src/index.ts";

function usage(overrides: Partial<GuardUsage> = {}): GuardUsage {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    calls: 1,
    retries: 0,
    durationMs: 10,
    status: "success",
    ...overrides,
  };
}

test("createSQLiteLogger bootstraps schema and inserts one row per log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await logger.log(
      usage({
        runId: "run-1",
        name: "first",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCostUsd: 0.002,
      }),
    );

    const report = readUsageReport({ dbPath });
    expect(report.totalRuns).toBe(1);
    expect(report.totalCalls).toBe(1);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(0.002);
    expect(report.mostExpensiveRun?.runId).toBe("run-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger creates parent directories by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "nested", "logs", "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });
    await logger.log(usage({ runId: "run-1" }));

    const report = readUsageReport({ dbPath });
    expect(report.totalRuns).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger propagates db open errors when mkdir is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "missing", "usage.db");

  try {
    await expect(createSQLiteLogger({ dbPath, mkdir: false })).rejects.toThrow(
      /unable to open database file|cannot open database because the directory does not exist/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger enforces unique run_id constraint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });
    const runUsage = usage({ runId: "run-duplicate" });

    await logger.log(runUsage);
    await expect(logger.log(runUsage)).rejects.toThrow(/UNIQUE constraint failed/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger stores status variants and created_at", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await logger.log(usage({ runId: "run-success", status: "success" }));
    await logger.log(
      usage({ runId: "run-blocked", status: "blocked", blockedReason: "CALL_LIMIT_EXCEEDED" }),
    );
    await logger.log(usage({ runId: "run-failed", status: "failed" }));
    await logger.log(usage({ runId: "run-timeout", status: "timeout", blockedReason: "TIMEOUT" }));

    const database = new Database(dbPath, { readonly: true });

    try {
      const rows = database
        .prepare(
          "SELECT run_id AS runId, status, blocked_reason AS blockedReason, created_at AS createdAt FROM guard_usage ORDER BY run_id",
        )
        .all() as Array<{
        runId: string;
        status: string;
        blockedReason: string | null;
        createdAt: string;
      }>;

      expect(rows).toHaveLength(4);
      expect(rows.map((row) => row.status).sort()).toEqual([
        "blocked",
        "failed",
        "success",
        "timeout",
      ]);
      expect(rows.every((row) => row.createdAt.includes("T"))).toBe(true);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readUsageReport supports date, name, and status filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await logger.log(
      usage({
        runId: "run-a",
        name: "alpha",
        status: "success",
        calls: 2,
        estimatedCostUsd: 0.01,
      }),
    );

    await logger.log(
      usage({
        runId: "run-b",
        name: "beta",
        status: "blocked",
        calls: 1,
        estimatedCostUsd: 0.02,
      }),
    );

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const filtered = readUsageReport({
      dbPath,
      filters: {
        from,
        to,
        name: "beta",
        status: "blocked",
      },
    });

    expect(filtered.totalRuns).toBe(1);
    expect(filtered.totalCalls).toBe(1);
    expect(filtered.blockedCalls).toBe(1);
    expect(filtered.timeouts).toBe(0);
    expect(filtered.totalEstimatedCostUsd).toBeCloseTo(0.02);
    expect(filtered.mostExpensiveRun?.runId).toBe("run-b");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readUsageReport errors when table is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const database = new Database(dbPath);
    database.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    database.close();

    expect(() => readUsageReport({ dbPath })).toThrow(/does not exist/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger rejects invalid table names before touching the database file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    await expect(
      createSQLiteLogger({
        dbPath,
        tableName: 'guard_usage"; DROP TABLE guard_usage; --',
      }),
    ).rejects.toThrow(/Invalid SQLite table name/i);

    await expect(access(dbPath)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger rejects traversal paths", async () => {
  await expect(createSQLiteLogger({ dbPath: "../outside/usage.db" })).rejects.toThrow(
    /path traversal|outside the current working directory/i,
  );
  await expect(createSQLiteLogger({ dbPath: "..\\\\outside\\\\usage.db" })).rejects.toThrow(
    /path traversal|outside the current working directory/i,
  );
  await expect(createSQLiteLogger({ dbPath: "%2E%2E/outside/usage.db" })).rejects.toThrow(
    /path traversal|outside the current working directory/i,
  );
});

test("readUsageReport rejects traversal paths", () => {
  expect(() => readUsageReport({ dbPath: "../outside/usage.db" })).toThrow(
    /path traversal|outside the current working directory/i,
  );
});

test("createSQLiteLogger enforces maxPendingWrites and fails fast", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath, maxPendingWrites: 1 });

    const firstWrite = logger.log(usage({ runId: "run-1" }));
    const secondWrite = logger.log(usage({ runId: "run-2" }));

    await expect(secondWrite).rejects.toThrow(/queue is full/i);
    await expect(firstWrite).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger queue drains after a transient write failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await logger.log(usage({ runId: "run-1" }));
    await expect(logger.log(usage({ runId: "run-1" }))).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
    await expect(logger.log(usage({ runId: "run-2" }))).resolves.toBeUndefined();

    const report = readUsageReport({ dbPath });
    expect(report.totalRuns).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger preserves write errors without swallowing persistent failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await logger.log(usage({ runId: "run-1" }));
    await expect(logger.log(usage({ runId: "run-1" }))).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
    await expect(logger.log(usage({ runId: "run-1" }))).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger close is idempotent and rejects writes after close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });
    await logger.log(usage({ runId: "run-1" }));

    logger.close();
    logger.close();

    await expect(logger.log(usage({ runId: "run-2" }))).rejects.toThrow(/closed/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createSQLiteLogger surfaces actionable initialization errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-sqlite-"));
  const dbPath = join(directory, "missing", "usage.db");

  try {
    await expect(createSQLiteLogger({ dbPath, mkdir: false })).rejects.toThrow(
      /Failed to initialize SQLite logger/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
