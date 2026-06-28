import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  BudgetCommitOptions,
  BudgetCommitResult,
  BudgetSnapshot,
  GuardLogger,
  GuardStatus,
  GuardUsage,
} from "@guard-sdk/core";

const DEFAULT_TABLE_NAME = "guard_usage";
const DEFAULT_BUDGET_TABLE_NAME = "guard_budget";
const DEFAULT_MAX_PENDING_WRITES = 1000;

const SQLITE_WRITE_QUEUE_FULL_ERROR = "SQLITE_WRITE_QUEUE_FULL";
const SQLITE_LOGGER_CLOSED_ERROR = "SQLITE_LOGGER_CLOSED";

class SQLiteLoggerQueueFullError extends Error {
  readonly code = SQLITE_WRITE_QUEUE_FULL_ERROR;

  constructor(maxPendingWrites: number) {
    super(`SQLite logger queue is full (maxPendingWrites: ${maxPendingWrites}).`);
    this.name = "SQLiteLoggerQueueFullError";
  }
}

class SQLiteLoggerClosedError extends Error {
  readonly code = SQLITE_LOGGER_CLOSED_ERROR;

  constructor() {
    super("SQLite logger is closed.");
    this.name = "SQLiteLoggerClosedError";
  }
}

type DatabaseRow = {
  totalRuns: number;
  totalCalls: number;
  totalEstimatedCostUsd: number;
  blockedCalls: number;
  timeouts: number;
};

type MostExpensiveRunRow = {
  runId: string;
  name: string | null;
  estimatedCostUsd: number | null;
};

export type SQLiteLoggerOptions = {
  dbPath: string;
  mkdir?: boolean;
  tableName?: string;
  maxPendingWrites?: number;
};

export type SQLiteLogger = GuardLogger & {
  close: () => void;
};

export type UsageReportFilters = {
  from?: string;
  to?: string;
  name?: string;
  status?: GuardStatus;
};

export type ReadUsageReportOptions = {
  dbPath: string;
  tableName?: string;
  filters?: UsageReportFilters;
};

export type UsageReportSummary = {
  totalRuns: number;
  totalCalls: number;
  totalEstimatedCostUsd: number;
  blockedCalls: number;
  timeouts: number;
  mostExpensiveRun?: {
    runId: string;
    name?: string;
    estimatedCostUsd: number;
  };
};

function validateTableName(tableName: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid SQLite table name: ${tableName}`);
  }
}

function sqlIdentifier(identifier: string): string {
  validateTableName(identifier);
  return `"${identifier.replaceAll('"', '""')}"`;
}

function validateMaxPendingWrites(maxPendingWrites: number) {
  if (!Number.isInteger(maxPendingWrites) || maxPendingWrites <= 0) {
    throw new Error(`maxPendingWrites must be a positive integer. Received: ${maxPendingWrites}`);
  }
}

function resolveSafeFilePath(pathValue: string, label: string): string {
  if (!pathValue || typeof pathValue !== "string") {
    throw new Error(`${label} must be a non-empty string.`);
  }

  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(pathValue);
  } catch {
    throw new Error(`${label} contains invalid URI encoding.`);
  }

  if (decodedPath.includes("\0")) {
    throw new Error(`${label} contains invalid null bytes.`);
  }

  if (isAbsolute(decodedPath)) {
    return resolve(decodedPath);
  }

  const normalizedForTraversal = decodedPath.replaceAll("\\", "/");

  if (normalizedForTraversal.split("/").includes("..")) {
    throw new Error(`${label} must not contain path traversal segments.`);
  }

  const resolvedPath = resolve(process.cwd(), decodedPath);
  const relativePath = relative(process.cwd(), resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} resolves outside the current working directory.`);
  }

  return resolvedPath;
}

function createSchemaSql(tableName: string) {
  const tableIdentifier = sqlIdentifier(tableName);
  const createdAtIndexIdentifier = sqlIdentifier(`${tableName}_created_at_idx`);
  const statusIndexIdentifier = sqlIdentifier(`${tableName}_status_idx`);
  const nameIndexIdentifier = sqlIdentifier(`${tableName}_name_idx`);
  const createdAtStatusIndexIdentifier = sqlIdentifier(`${tableName}_created_at_status_idx`);

  return `
CREATE TABLE IF NOT EXISTS ${tableIdentifier} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  name TEXT,
  user_id TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost_usd REAL,
  calls INTEGER NOT NULL,
  retries INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  blocked_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${createdAtIndexIdentifier} ON ${tableIdentifier} (created_at);
CREATE INDEX IF NOT EXISTS ${statusIndexIdentifier} ON ${tableIdentifier} (status);
CREATE INDEX IF NOT EXISTS ${nameIndexIdentifier} ON ${tableIdentifier} (name);
CREATE INDEX IF NOT EXISTS ${createdAtStatusIndexIdentifier} ON ${tableIdentifier} (created_at, status);
`;
}

function buildWhereClause(filters: UsageReportFilters) {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.from) {
    conditions.push("created_at >= @from");
    params.from = filters.from;
  }

  if (filters.to) {
    conditions.push("created_at <= @to");
    params.to = filters.to;
  }

  if (filters.name) {
    conditions.push("name = @name");
    params.name = filters.name;
  }

  if (filters.status) {
    conditions.push("status = @status");
    params.status = filters.status;
  }

  if (conditions.length === 0) {
    return {
      whereClause: "",
      params,
    };
  }

  return {
    whereClause: `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

function assertTableExists(database: Database.Database, tableName: string) {
  const row = database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = @tableName`,
    )
    .get({ tableName }) as { name?: string } | undefined;

  if (!row?.name) {
    throw new Error(`SQLite table "${tableName}" does not exist.`);
  }
}

function buildInsertParams(usage: GuardUsage) {
  return {
    runId: usage.runId,
    name: usage.name ?? null,
    userId: usage.userId ?? null,
    provider: usage.provider ?? null,
    model: usage.model ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    estimatedCostUsd: usage.estimatedCostUsd ?? null,
    calls: usage.calls,
    retries: usage.retries,
    durationMs: usage.durationMs,
    status: usage.status,
    blockedReason: usage.blockedReason ?? null,
    createdAt: new Date().toISOString(),
  };
}

export async function createSQLiteLogger(options: SQLiteLoggerOptions): Promise<SQLiteLogger> {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  validateTableName(tableName);

  const maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
  validateMaxPendingWrites(maxPendingWrites);

  const dbPath = resolveSafeFilePath(options.dbPath, "dbPath");

  if (options.mkdir ?? true) {
    await mkdir(dirname(dbPath), { recursive: true });
  }

  let database: Database.Database | undefined;

  try {
    database = new Database(dbPath);
    database.exec(createSchemaSql(tableName));
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // ignore close errors during init failure.
      }
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize SQLite logger at "${dbPath}": ${reason}`);
  }

  const tableIdentifier = sqlIdentifier(tableName);

  const insertStatement = database.prepare(`
INSERT INTO ${tableIdentifier} (
  run_id,
  name,
  user_id,
  provider,
  model,
  input_tokens,
  output_tokens,
  total_tokens,
  estimated_cost_usd,
  calls,
  retries,
  duration_ms,
  status,
  blocked_reason,
  created_at
) VALUES (
  @runId,
  @name,
  @userId,
  @provider,
  @model,
  @inputTokens,
  @outputTokens,
  @totalTokens,
  @estimatedCostUsd,
  @calls,
  @retries,
  @durationMs,
  @status,
  @blockedReason,
  @createdAt
);
`);

  let writeQueue = Promise.resolve();
  let pendingWrites = 0;
  let acceptsWrites = true;
  let isClosed = false;
  let closeScheduled = false;

  const closeDatabase = () => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    database.close();
  };

  return {
    log(usage: GuardUsage) {
      if (!acceptsWrites || isClosed) {
        return Promise.reject(new SQLiteLoggerClosedError());
      }

      if (pendingWrites >= maxPendingWrites) {
        return Promise.reject(new SQLiteLoggerQueueFullError(maxPendingWrites));
      }

      const usageSnapshot = { ...usage };
      pendingWrites += 1;

      const currentWrite = writeQueue
        .catch(() => undefined)
        .then(() => {
          insertStatement.run(buildInsertParams(usageSnapshot));
        })
        .finally(() => {
          pendingWrites -= 1;
        });

      writeQueue = currentWrite.catch(() => undefined);

      return currentWrite;
    },

    close() {
      if (isClosed || closeScheduled) {
        return;
      }

      acceptsWrites = false;
      closeScheduled = true;

      if (pendingWrites === 0) {
        closeDatabase();
        return;
      }

      writeQueue = writeQueue
        .catch(() => undefined)
        .then(() => {
          closeDatabase();
        });
    },
  };
}

export type SQLiteBudgetStoreOptions = {
  dbPath: string;
  mkdir?: boolean;
  tableName?: string;
};

export type SQLiteBudgetStore = {
  get: (key: string) => BudgetSnapshot;
  add: (key: string, delta: BudgetSnapshot) => void;
  commit: (key: string, delta: BudgetSnapshot, options?: BudgetCommitOptions) => BudgetCommitResult;
  close: () => void;
};

type BudgetRow = {
  costUsd: number;
  totalTokens: number;
  calls: number;
};

function addBudgetSnapshots(current: BudgetSnapshot, delta: BudgetSnapshot): BudgetSnapshot {
  return {
    costUsd: current.costUsd + (delta.costUsd ?? 0),
    totalTokens: current.totalTokens + (delta.totalTokens ?? 0),
    calls: current.calls + (delta.calls ?? 0),
  };
}

function exceedsBudgetSnapshot(
  snapshot: BudgetSnapshot,
  limits: Partial<BudgetSnapshot> | undefined,
) {
  return (
    (limits?.costUsd !== undefined && snapshot.costUsd > limits.costUsd) ||
    (limits?.totalTokens !== undefined && snapshot.totalTokens > limits.totalTokens) ||
    (limits?.calls !== undefined && snapshot.calls > limits.calls)
  );
}

function createBudgetSchemaSql(tableName: string) {
  const tableIdentifier = sqlIdentifier(tableName);

  return `
CREATE TABLE IF NOT EXISTS ${tableIdentifier} (
  budget_key TEXT PRIMARY KEY,
  cost_usd REAL NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;
}

/**
 * Creates a persistent BudgetStore backed by SQLite. Cumulative spend
 * survives process restarts, so per-user budgets stay enforced across runs.
 */
export async function createSQLiteBudgetStore(
  options: SQLiteBudgetStoreOptions,
): Promise<SQLiteBudgetStore> {
  const tableName = options.tableName ?? DEFAULT_BUDGET_TABLE_NAME;
  validateTableName(tableName);

  const dbPath = resolveSafeFilePath(options.dbPath, "dbPath");

  if (options.mkdir ?? true) {
    await mkdir(dirname(dbPath), { recursive: true });
  }

  let database: Database.Database | undefined;

  try {
    database = new Database(dbPath);
    database.exec(createBudgetSchemaSql(tableName));
  } catch (error) {
    if (database) {
      try {
        database.close();
      } catch {
        // ignore close errors during init failure.
      }
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize SQLite budget store at "${dbPath}": ${reason}`);
  }

  const tableIdentifier = sqlIdentifier(tableName);

  const selectStatement = database.prepare(`
SELECT cost_usd AS costUsd, total_tokens AS totalTokens, calls AS calls
FROM ${tableIdentifier}
WHERE budget_key = @key;
`);

  const upsertStatement = database.prepare(`
INSERT INTO ${tableIdentifier} (budget_key, cost_usd, total_tokens, calls, updated_at)
VALUES (@key, @costUsd, @totalTokens, @calls, @updatedAt)
ON CONFLICT(budget_key) DO UPDATE SET
  cost_usd = cost_usd + excluded.cost_usd,
  total_tokens = total_tokens + excluded.total_tokens,
  calls = calls + excluded.calls,
  updated_at = excluded.updated_at;
`);

  let isClosed = false;

  const readSnapshot = (key: string): BudgetSnapshot => {
    const row = selectStatement.get({ key }) as BudgetRow | undefined;

    if (!row) {
      return { costUsd: 0, totalTokens: 0, calls: 0 };
    }

    return {
      costUsd: Number(row.costUsd) || 0,
      totalTokens: Number(row.totalTokens) || 0,
      calls: Number(row.calls) || 0,
    };
  };

  const commitTransaction = database.transaction(
    (
      key: string,
      delta: BudgetSnapshot,
      options: BudgetCommitOptions | undefined,
    ): BudgetCommitResult => {
      const current = readSnapshot(key);
      const next = addBudgetSnapshots(current, delta);

      if (exceedsBudgetSnapshot(next, options?.rejectIfExceeded)) {
        return {
          snapshot: current,
          rejected: true,
        };
      }

      upsertStatement.run({
        key,
        costUsd: delta.costUsd ?? 0,
        totalTokens: delta.totalTokens ?? 0,
        calls: delta.calls ?? 0,
        updatedAt: new Date().toISOString(),
      });

      return {
        snapshot: next,
        rejected: false,
      };
    },
  );

  return {
    get(key: string): BudgetSnapshot {
      if (isClosed) {
        // Returning a zero snapshot here would silently reset the baseline and
        // let an over-budget key slip through; surface the misuse instead.
        throw new Error("SQLite budget store is closed.");
      }

      return readSnapshot(key);
    },
    add(key: string, delta: BudgetSnapshot) {
      if (isClosed) {
        // Dropping the write silently would lose spend; surface the misuse.
        throw new Error("SQLite budget store is closed.");
      }

      upsertStatement.run({
        key,
        costUsd: delta.costUsd ?? 0,
        totalTokens: delta.totalTokens ?? 0,
        calls: delta.calls ?? 0,
        updatedAt: new Date().toISOString(),
      });
    },
    commit(key: string, delta: BudgetSnapshot, options?: BudgetCommitOptions) {
      if (isClosed) {
        throw new Error("SQLite budget store is closed.");
      }

      return commitTransaction(key, delta, options);
    },
    close() {
      if (isClosed) {
        return;
      }

      isClosed = true;
      database.close();
    },
  };
}

export function readUsageReport(options: ReadUsageReportOptions): UsageReportSummary {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  validateTableName(tableName);

  const dbPath = resolveSafeFilePath(options.dbPath, "dbPath");

  const database = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });

  const tableIdentifier = sqlIdentifier(tableName);

  try {
    assertTableExists(database, tableName);

    const filters = options.filters ?? {};
    const { whereClause, params } = buildWhereClause(filters);

    const aggregateRow = database
      .prepare(
        `SELECT
          COUNT(*) AS totalRuns,
          COALESCE(SUM(calls), 0) AS totalCalls,
          COALESCE(SUM(estimated_cost_usd), 0) AS totalEstimatedCostUsd,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blockedCalls,
          COALESCE(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END), 0) AS timeouts
        FROM ${tableIdentifier}
        ${whereClause}`,
      )
      .get(params) as DatabaseRow;

    const mostExpensive = database
      .prepare(
        `SELECT
          run_id AS runId,
          name,
          estimated_cost_usd AS estimatedCostUsd
        FROM ${tableIdentifier}
        ${whereClause}
        ORDER BY estimated_cost_usd DESC, created_at ASC
        LIMIT 1`,
      )
      .get(params) as MostExpensiveRunRow | undefined;

    const summary: UsageReportSummary = {
      totalRuns: Number(aggregateRow.totalRuns),
      totalCalls: Number(aggregateRow.totalCalls),
      totalEstimatedCostUsd: Number(aggregateRow.totalEstimatedCostUsd),
      blockedCalls: Number(aggregateRow.blockedCalls),
      timeouts: Number(aggregateRow.timeouts),
    };

    if (
      mostExpensive &&
      mostExpensive.estimatedCostUsd !== null &&
      Number.isFinite(Number(mostExpensive.estimatedCostUsd))
    ) {
      summary.mostExpensiveRun = {
        runId: mostExpensive.runId,
        name: mostExpensive.name ?? undefined,
        estimatedCostUsd: Number(mostExpensive.estimatedCostUsd),
      };
    }

    return summary;
  } finally {
    database.close();
  }
}
