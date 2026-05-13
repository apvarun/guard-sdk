import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { GuardLogger, GuardStatus, GuardUsage } from "@guard-sdk/core";

const DEFAULT_TABLE_NAME = "guard_usage";

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

function createSchemaSql(tableName: string) {
  return `
CREATE TABLE IF NOT EXISTS "${tableName}" (
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
CREATE INDEX IF NOT EXISTS "${tableName}_created_at_idx" ON "${tableName}" (created_at);
CREATE INDEX IF NOT EXISTS "${tableName}_status_idx" ON "${tableName}" (status);
CREATE INDEX IF NOT EXISTS "${tableName}_name_idx" ON "${tableName}" (name);
CREATE INDEX IF NOT EXISTS "${tableName}_created_at_status_idx" ON "${tableName}" (created_at, status);
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

export async function createSQLiteLogger(options: SQLiteLoggerOptions): Promise<GuardLogger> {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  validateTableName(tableName);

  if (options.mkdir ?? true) {
    await mkdir(dirname(options.dbPath), { recursive: true });
  }

  const database = new Database(options.dbPath);
  database.exec(createSchemaSql(tableName));

  const insertStatement = database.prepare(`
INSERT INTO "${tableName}" (
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

  return {
    log(usage: GuardUsage) {
      const usageSnapshot = { ...usage };

      writeQueue = writeQueue
        .catch(() => undefined)
        .then(() => {
          insertStatement.run({
            runId: usageSnapshot.runId,
            name: usageSnapshot.name ?? null,
            userId: usageSnapshot.userId ?? null,
            provider: usageSnapshot.provider ?? null,
            model: usageSnapshot.model ?? null,
            inputTokens: usageSnapshot.inputTokens ?? null,
            outputTokens: usageSnapshot.outputTokens ?? null,
            totalTokens: usageSnapshot.totalTokens ?? null,
            estimatedCostUsd: usageSnapshot.estimatedCostUsd ?? null,
            calls: usageSnapshot.calls,
            retries: usageSnapshot.retries,
            durationMs: usageSnapshot.durationMs,
            status: usageSnapshot.status,
            blockedReason: usageSnapshot.blockedReason ?? null,
            createdAt: new Date().toISOString(),
          });
        });

      return writeQueue;
    },
  };
}

export function readUsageReport(options: ReadUsageReportOptions): UsageReportSummary {
  const tableName = options.tableName ?? DEFAULT_TABLE_NAME;
  validateTableName(tableName);

  const database = new Database(options.dbPath, {
    readonly: true,
    fileMustExist: true,
  });

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
        FROM "${tableName}"
        ${whereClause}`,
      )
      .get(params) as DatabaseRow;

    const mostExpensive = database
      .prepare(
        `SELECT
          run_id AS runId,
          name,
          estimated_cost_usd AS estimatedCostUsd
        FROM "${tableName}"
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
