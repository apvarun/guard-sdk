import type { PricingResolver } from "@guard-sdk/pricing";
export type GuardStatus = "success" | "failed" | "blocked" | "timeout";
export type GuardMode = "enforce" | "dry-run";
export type GuardPolicyReason = "CALL_LIMIT_EXCEEDED" | "TOKEN_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED";
export type GuardLogger = {
    log: (usage: GuardUsage) => Promise<void> | void;
};
export type GuardConfig = {
    name?: string;
    userId?: string;
    mode?: GuardMode;
    maxCostUsd?: number;
    maxTokens?: number;
    maxCalls?: number;
    maxRetries?: number;
    timeoutMs?: number;
    provider?: string;
    model?: string;
    pricing?: PricingResolver;
    tokenizer?: (value: unknown) => number | Promise<number>;
    logger?: GuardLogger;
};
export type GuardUsage = {
    runId: string;
    name?: string;
    userId?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    calls: number;
    retries: number;
    durationMs: number;
    status: GuardStatus;
    blockedReason?: string;
    wouldBlock?: boolean;
    wouldBlockReasons?: GuardPolicyReason[];
};
export type GuardResult<T> = {
    data: T;
    usage: GuardUsage;
};
export type GuardRun = {
    call: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    summary: () => GuardUsage;
};
