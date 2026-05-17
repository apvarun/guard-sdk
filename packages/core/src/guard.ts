import { getModelPricing } from "@guard-sdk/pricing";
import {
  BudgetExceededError,
  CallLimitExceededError,
  GuardError,
  TimeoutError,
  TokenLimitExceededError,
} from "./errors.js";
import type { GuardConfig, GuardPolicyReason, GuardResult, GuardRun, GuardUsage } from "./types.js";

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function isDryRunMode(config: GuardConfig) {
  return config.mode === "dry-run";
}

function createRunId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function copyUsage(usage: GuardUsage): GuardUsage {
  return { ...usage };
}

function withDuration(usage: GuardUsage, startedAt: number): GuardUsage {
  return {
    ...usage,
    durationMs: Date.now() - startedAt,
  };
}

function extractUsageObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = (value as { usage?: unknown }).usage;

  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  return usage as Record<string, unknown>;
}

function extractTokenWithFallback(
  usage: Record<string, unknown>,
  primary: string,
  fallback: string,
): number | undefined {
  return toNumber(usage[primary]) ?? toNumber(usage[fallback]);
}

function calculateTotalTokens(
  explicitTotal: number | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (explicitTotal !== undefined) {
    return explicitTotal;
  }

  if (inputTokens !== undefined || outputTokens !== undefined) {
    return (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  return undefined;
}

function extractProviderUsage(value: unknown): TokenUsage | undefined {
  const usage = extractUsageObject(value);

  if (!usage) {
    return undefined;
  }

  const inputTokens = extractTokenWithFallback(usage, "prompt_tokens", "input_tokens");
  const outputTokens = extractTokenWithFallback(usage, "completion_tokens", "output_tokens");
  const explicitTotal = toNumber(usage.total_tokens);

  const totalTokens = calculateTotalTokens(explicitTotal, inputTokens, outputTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function estimateTokensFromHeuristic(value: unknown): TokenUsage {
  let serialized = "";

  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = "";
  }

  const totalTokens = Math.ceil(serialized.length / 4);

  return {
    totalTokens,
  };
}

function normalizeTokenizerResult(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

async function estimateTokensFromValue(
  value: unknown,
  tokenizer: GuardConfig["tokenizer"],
): Promise<TokenUsage> {
  if (typeof tokenizer !== "function") {
    return estimateTokensFromHeuristic(value);
  }

  try {
    const tokenCount = normalizeTokenizerResult(await tokenizer(value));

    if (tokenCount !== undefined) {
      return { totalTokens: tokenCount };
    }
  } catch {
    // fall back to heuristic estimate when tokenizer errors.
  }

  return estimateTokensFromHeuristic(value);
}

function accumulateToken(current: number | undefined, next: number): number {
  return (current ?? 0) + next;
}

function mergeTokenUsage(current: GuardUsage, next: TokenUsage) {
  if (next.inputTokens !== undefined) {
    current.inputTokens = accumulateToken(current.inputTokens, next.inputTokens);
  }

  if (next.outputTokens !== undefined) {
    current.outputTokens = accumulateToken(current.outputTokens, next.outputTokens);
  }

  if (next.totalTokens !== undefined) {
    current.totalTokens = accumulateToken(current.totalTokens, next.totalTokens);
    return;
  }

  if (next.inputTokens !== undefined || next.outputTokens !== undefined) {
    current.totalTokens = accumulateToken(
      current.totalTokens,
      (next.inputTokens ?? 0) + (next.outputTokens ?? 0),
    );
  }
}

function estimateCostUsd(config: GuardConfig, usage: GuardUsage): number | undefined {
  if (!config.provider || !config.model) {
    return undefined;
  }

  const pricing =
    config.pricing?.getPricing(config.provider, config.model) ??
    getModelPricing(config.provider, config.model);

  if (!pricing) {
    return undefined;
  }

  const inputTokens = usage.inputTokens ?? usage.totalTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillionTokens;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillionTokens;

  return inputCost + outputCost;
}

function attachUsage<T extends GuardError>(error: T, usage: GuardUsage): T {
  error.usage = usage;
  return error;
}

function getPreCallLimitViolations(config: GuardConfig, usage: GuardUsage): GuardPolicyReason[] {
  const violations: GuardPolicyReason[] = [];

  if (config.maxCalls !== undefined && usage.calls >= config.maxCalls) {
    violations.push("CALL_LIMIT_EXCEEDED");
  }

  if (config.maxTokens !== undefined && (usage.totalTokens ?? 0) >= config.maxTokens) {
    violations.push("TOKEN_LIMIT_EXCEEDED");
  }

  if (config.maxCostUsd !== undefined && (usage.estimatedCostUsd ?? 0) >= config.maxCostUsd) {
    violations.push("BUDGET_EXCEEDED");
  }

  return violations;
}

function getPostCallLimitViolations(config: GuardConfig, usage: GuardUsage): GuardPolicyReason[] {
  const violations: GuardPolicyReason[] = [];

  if (config.maxTokens !== undefined && (usage.totalTokens ?? 0) > config.maxTokens) {
    violations.push("TOKEN_LIMIT_EXCEEDED");
  }

  if (
    config.maxCostUsd !== undefined &&
    usage.estimatedCostUsd !== undefined &&
    usage.estimatedCostUsd > config.maxCostUsd
  ) {
    violations.push("BUDGET_EXCEEDED");
  }

  return violations;
}

function checkPreCallLimits(config: GuardConfig, usage: GuardUsage) {
  for (const violation of getPreCallLimitViolations(config, usage)) {
    if (violation === "CALL_LIMIT_EXCEEDED") {
      throw new CallLimitExceededError("Maximum call limit reached", usage);
    }

    if (violation === "TOKEN_LIMIT_EXCEEDED") {
      throw new TokenLimitExceededError("Maximum token limit reached", usage);
    }

    if (violation === "BUDGET_EXCEEDED") {
      throw new BudgetExceededError("Maximum cost budget reached", usage);
    }
  }
}

function checkPostCallLimits(config: GuardConfig, usage: GuardUsage) {
  for (const violation of getPostCallLimitViolations(config, usage)) {
    if (violation === "TOKEN_LIMIT_EXCEEDED") {
      throw new TokenLimitExceededError("Token limit exceeded", usage);
    }

    if (violation === "BUDGET_EXCEEDED") {
      throw new BudgetExceededError("Cost budget exceeded", usage);
    }
  }
}

async function executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fn();
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race<T>([
      fn(),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new TimeoutError(`Call exceeded timeout of ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

class GuardRunController {
  private readonly startedAt = Date.now();
  private readonly usage: GuardUsage;
  private readonly config: GuardConfig;
  private loggerEmitted = false;

  constructor(config: GuardConfig) {
    this.config = config;
    this.usage = {
      runId: createRunId(),
      name: config.name,
      userId: config.userId,
      provider: config.provider,
      model: config.model,
      calls: 0,
      retries: 0,
      durationMs: 0,
      status: "success",
    };
  }

  private snapshotUsage() {
    return withDuration(copyUsage(this.usage), this.startedAt);
  }

  private setStatus(status: GuardUsage["status"], blockedReason?: string) {
    this.usage.status = status;
    this.usage.blockedReason = blockedReason;
  }

  private recordWouldBlockReasons(reasons: GuardPolicyReason[]) {
    if (reasons.length === 0) {
      return;
    }

    const current = new Set(this.usage.wouldBlockReasons ?? []);

    for (const reason of reasons) {
      current.add(reason);
    }

    this.usage.wouldBlock = true;
    this.usage.wouldBlockReasons = [...current];
  }

  private async logOnce() {
    if (this.loggerEmitted || !this.config.logger) {
      return;
    }

    this.loggerEmitted = true;
    await this.config.logger.log(this.snapshotUsage());
  }

  private async handlePreCallLimits() {
    const usageSnapshot = this.snapshotUsage();

    if (isDryRunMode(this.config)) {
      this.recordWouldBlockReasons(getPreCallLimitViolations(this.config, usageSnapshot));
      return;
    }

    try {
      checkPreCallLimits(this.config, usageSnapshot);
    } catch (error) {
      if (
        error instanceof BudgetExceededError ||
        error instanceof TokenLimitExceededError ||
        error instanceof CallLimitExceededError
      ) {
        this.setStatus("blocked", error.code);
        await this.logOnce();
        throw attachUsage(error, this.snapshotUsage());
      }

      throw error;
    }
  }

  private async executeSingleAttempt<T>(fn: () => Promise<T>): Promise<{
    data: T;
    tokenUsage: TokenUsage;
  }> {
    const data = await executeWithTimeout(fn, this.config.timeoutMs);
    const tokenUsage =
      extractProviderUsage(data) ?? (await estimateTokensFromValue(data, this.config.tokenizer));

    return { data, tokenUsage };
  }

  private processSuccessfulAttempt(tokenUsage: TokenUsage) {
    mergeTokenUsage(this.usage, tokenUsage);

    const estimatedCostUsd = estimateCostUsd(this.config, this.usage);

    if (estimatedCostUsd !== undefined) {
      this.usage.estimatedCostUsd = estimatedCostUsd;
    }

    const usageSnapshot = this.snapshotUsage();

    if (isDryRunMode(this.config)) {
      this.recordWouldBlockReasons(getPostCallLimitViolations(this.config, usageSnapshot));
    } else {
      checkPostCallLimits(this.config, usageSnapshot);
    }

    this.setStatus("success");
  }

  private async handleAttemptError(
    error: unknown,
    attempt: number,
    maxRetries: number,
  ): Promise<{
    shouldRetry: boolean;
    errorToThrow?: unknown;
  }> {
    if (error instanceof TimeoutError) {
      this.setStatus("timeout", "TIMEOUT");
      await this.logOnce();
      return {
        shouldRetry: false,
        errorToThrow: new TimeoutError(error.message, this.snapshotUsage()),
      };
    }

    if (
      error instanceof BudgetExceededError ||
      error instanceof TokenLimitExceededError ||
      error instanceof CallLimitExceededError
    ) {
      this.setStatus("blocked", error.code);
      await this.logOnce();
      return {
        shouldRetry: false,
        errorToThrow: attachUsage(error, this.snapshotUsage()),
      };
    }

    const canRetry = attempt < maxRetries;

    if (canRetry) {
      this.usage.retries += 1;
      return { shouldRetry: true }; // Signal to retry
    }

    this.setStatus("failed");
    await this.logOnce();

    if (error instanceof GuardError) {
      return {
        shouldRetry: false,
        errorToThrow: attachUsage(error, this.snapshotUsage()),
      };
    }

    return {
      shouldRetry: false,
      errorToThrow: error,
    };
  }

  async call<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    await this.handlePreCallLimits();

    this.usage.calls += 1;

    const maxRetries = Math.max(0, this.config.maxRetries ?? 0);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const { data, tokenUsage } = await this.executeSingleAttempt(fn);
        this.processSuccessfulAttempt(tokenUsage);

        return data;
      } catch (error) {
        const result = await this.handleAttemptError(error, attempt, maxRetries);

        if (result.shouldRetry) {
          continue; // Retry the attempt
        }

        if (result.errorToThrow) {
          throw result.errorToThrow;
        }
      }
    }

    this.setStatus("failed");
    await this.logOnce();
    throw new GuardError("UNREACHABLE", "Unexpected guard runtime state", this.snapshotUsage());
  }

  summary(): GuardUsage {
    if (this.usage.status === "success") {
      void this.logOnce();
    }

    return this.snapshotUsage();
  }

  async finishSuccessLog() {
    if (this.usage.status === "success") {
      await this.logOnce();
    }
  }
}

export const guard = {
  async run<T>(fn: () => Promise<T>, config: GuardConfig = {}): Promise<GuardResult<T>> {
    const run = new GuardRunController(config);
    const data = await run.call(config.name ?? "run", fn);
    await run.finishSuccessLog();

    return {
      data,
      usage: run.summary(),
    };
  },

  createRun(config: GuardConfig = {}): GuardRun {
    const run = new GuardRunController(config);

    return {
      call: <T>(name: string, fn: () => Promise<T>) => run.call(name, fn),
      summary: () => run.summary(),
    };
  },
};
