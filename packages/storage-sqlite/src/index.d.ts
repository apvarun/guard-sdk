import type { BudgetCommitOptions, BudgetCommitResult, BudgetSnapshot, GuardLogger, GuardStatus } from "@guard-sdk/core";
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
export declare function createSQLiteLogger(options: SQLiteLoggerOptions): Promise<SQLiteLogger>;
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
/**
 * Creates a persistent BudgetStore backed by SQLite. Cumulative spend
 * survives process restarts, so per-user budgets stay enforced across runs.
 */
export declare function createSQLiteBudgetStore(options: SQLiteBudgetStoreOptions): Promise<SQLiteBudgetStore>;
export declare function readUsageReport(options: ReadUsageReportOptions): UsageReportSummary;
