import type { GuardLogger, GuardStatus } from "@guard-sdk/core";
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
export declare function readUsageReport(options: ReadUsageReportOptions): UsageReportSummary;
