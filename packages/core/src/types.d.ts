import type { PricingResolver } from "@guard-sdk/pricing";
export type GuardStatus = "success" | "failed" | "blocked" | "timeout";
export type GuardLogger = {
  log: (usage: GuardUsage) => Promise<void> | void;
};
export type GuardConfig = {
  name?: string;
  userId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  maxCalls?: number;
  maxRetries?: number;
  timeoutMs?: number;
  provider?: string;
  model?: string;
  pricing?: PricingResolver;
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
};
export type GuardResult<T> = {
  data: T;
  usage: GuardUsage;
};
export type GuardRun = {
  call: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  summary: () => GuardUsage;
};
