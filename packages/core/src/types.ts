import type { PricingResolver } from "@guard-sdk/pricing";

export type GuardStatus = "success" | "failed" | "blocked" | "timeout";
export type GuardMode = "enforce" | "dry-run";
export type GuardPolicyReason = "CALL_LIMIT_EXCEEDED" | "TOKEN_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED";
export type GuardWarningReason = "COST_WARNING" | "TOKEN_WARNING";
export type GuardBudgetWindow = "day" | "month" | "total";

export type GuardWarning = {
  reason: GuardWarningReason;
  message: string;
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
  warnings?: GuardWarning[];
};

export type GuardLogger = {
  log: (usage: GuardUsage) => Promise<void> | void;
};

/**
 * Context passed to the guarded function. The `signal` aborts when the run
 * times out or when a caller-supplied `signal` aborts, so providers that
 * accept an `AbortSignal` can cancel in-flight requests.
 */
export type GuardCallContext = {
  signal: AbortSignal;
};

/**
 * The error passed to `onBlock`. At runtime this is always a `GuardError`
 * instance, so `instanceof` checks against the exported error classes work as
 * expected.
 */
export type GuardBlockError = {
  name: string;
  message: string;
  readonly code: string;
  usage?: GuardUsage;
};

/**
 * Optional lifecycle callbacks. A hook that throws is caught and never breaks
 * the guarded call, so hooks are safe to use for alerting and metrics.
 */
export type GuardHooks = {
  onStart?: (usage: GuardUsage) => void | Promise<void>;
  onCall?: (usage: GuardUsage) => void | Promise<void>;
  onRetry?: (usage: GuardUsage) => void | Promise<void>;
  onBlock?: (usage: GuardUsage, error: GuardBlockError) => void | Promise<void>;
  onFinish?: (usage: GuardUsage) => void | Promise<void>;
  onWarn?: (usage: GuardUsage, warning: GuardWarning) => void | Promise<void>;
};

/**
 * Cumulative usage recorded by a budget store for a single budget key.
 */
export type BudgetSnapshot = {
  costUsd: number;
  totalTokens: number;
  calls: number;
};

export type BudgetCommitOptions = {
  rejectIfExceeded?: Partial<BudgetSnapshot>;
};

export type BudgetCommitResult = {
  snapshot: BudgetSnapshot;
  rejected: boolean;
};

/**
 * Tracks spend across many runs keyed by `userId` (or an explicit
 * `budgetKey`), enabling per-user budgets that span individual runs.
 */
export type BudgetStore = {
  get: (key: string) => Promise<BudgetSnapshot> | BudgetSnapshot;
  add: (key: string, delta: BudgetSnapshot) => Promise<void> | void;
  commit?: (
    key: string,
    delta: BudgetSnapshot,
    options?: BudgetCommitOptions,
  ) => Promise<BudgetCommitResult> | BudgetCommitResult;
};

export type GuardConfig = {
  name?: string;
  userId?: string;
  provider?: string;
  model?: string;
  mode?: GuardMode;
  maxCostUsd?: number;
  maxTokens?: number;
  maxCalls?: number;
  maxRetries?: number;
  timeoutMs?: number;
  warnAtCostUsd?: number;
  warnAtTokens?: number;
  budgetKey?: string;
  budgetWindow?: GuardBudgetWindow;
  maxUserCostUsd?: number;
  maxUserTokens?: number;
  maxUserCalls?: number;
  pricing?: PricingResolver;
  tokenizer?: (value: unknown) => number | Promise<number>;
  logger?: GuardLogger;
  hooks?: GuardHooks;
  signal?: AbortSignal;
  budget?: BudgetStore;
};

export type GuardResult<T> = {
  data: T;
  usage: GuardUsage;
};

export type GuardRun = {
  call: <T>(name: string, fn: (ctx: GuardCallContext) => Promise<T>) => Promise<T>;
  summary: () => GuardUsage;
};

export type GuardStreamRun = {
  finish: <T>(fn: () => Promise<T> | T) => Promise<T>;
  summary: () => GuardUsage;
};
