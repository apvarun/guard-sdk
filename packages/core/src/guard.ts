import { getModelPricing } from "@guard-sdk/pricing";
import {
  BudgetExceededError,
  CallLimitExceededError,
  GuardError,
  TimeoutError,
  TokenLimitExceededError,
} from "./errors.js";
import type { GuardConfig, GuardResult, GuardRun, GuardUsage } from "./types.js";

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

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

function extractProviderUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = (value as { usage?: unknown }).usage;

  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const promptTokens =
    toNumber((usage as Record<string, unknown>).prompt_tokens) ??
    toNumber((usage as Record<string, unknown>).input_tokens);

  const completionTokens =
    toNumber((usage as Record<string, unknown>).completion_tokens) ??
    toNumber((usage as Record<string, unknown>).output_tokens);

  const explicitTotal = toNumber((usage as Record<string, unknown>).total_tokens);

  const totalTokens =
    explicitTotal ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
  };
}

function estimateTokensFromValue(value: unknown): TokenUsage {
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

function mergeTokenUsage(current: GuardUsage, next: TokenUsage) {
  if (next.inputTokens !== undefined) {
    current.inputTokens = (current.inputTokens ?? 0) + next.inputTokens;
  }

  if (next.outputTokens !== undefined) {
    current.outputTokens = (current.outputTokens ?? 0) + next.outputTokens;
  }

  if (next.totalTokens !== undefined) {
    current.totalTokens = (current.totalTokens ?? 0) + next.totalTokens;
    return;
  }

  if (next.inputTokens !== undefined || next.outputTokens !== undefined) {
    current.totalTokens =
      (current.totalTokens ?? 0) + (next.inputTokens ?? 0) + (next.outputTokens ?? 0);
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

function checkPreCallLimits(config: GuardConfig, usage: GuardUsage) {
  if (config.maxCalls !== undefined && usage.calls >= config.maxCalls) {
    throw new CallLimitExceededError("Maximum call limit reached", usage);
  }

  if (config.maxTokens !== undefined && (usage.totalTokens ?? 0) >= config.maxTokens) {
    throw new TokenLimitExceededError("Maximum token limit reached", usage);
  }

  if (config.maxCostUsd !== undefined && (usage.estimatedCostUsd ?? 0) >= config.maxCostUsd) {
    throw new BudgetExceededError("Maximum cost budget reached", usage);
  }
}

function checkPostCallLimits(config: GuardConfig, usage: GuardUsage) {
  if (config.maxTokens !== undefined && (usage.totalTokens ?? 0) > config.maxTokens) {
    throw new TokenLimitExceededError("Token limit exceeded", usage);
  }

  if (
    config.maxCostUsd !== undefined &&
    usage.estimatedCostUsd !== undefined &&
    usage.estimatedCostUsd > config.maxCostUsd
  ) {
    throw new BudgetExceededError("Cost budget exceeded", usage);
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

  private async logOnce() {
    if (this.loggerEmitted || !this.config.logger) {
      return;
    }

    this.loggerEmitted = true;
    await this.config.logger.log(this.snapshotUsage());
  }

  async call<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    try {
      checkPreCallLimits(this.config, this.snapshotUsage());
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

    this.usage.calls += 1;

    const maxRetries = Math.max(0, this.config.maxRetries ?? 0);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const data = await executeWithTimeout(fn, this.config.timeoutMs);
        const tokenUsage = extractProviderUsage(data) ?? estimateTokensFromValue(data);
        mergeTokenUsage(this.usage, tokenUsage);

        const estimatedCostUsd = estimateCostUsd(this.config, this.usage);

        if (estimatedCostUsd !== undefined) {
          this.usage.estimatedCostUsd = estimatedCostUsd;
        }

        checkPostCallLimits(this.config, this.snapshotUsage());
        this.setStatus("success");

        return data;
      } catch (error) {
        if (error instanceof TimeoutError) {
          this.setStatus("timeout", "TIMEOUT");
          await this.logOnce();
          throw new TimeoutError(error.message, this.snapshotUsage());
        }

        if (
          error instanceof BudgetExceededError ||
          error instanceof TokenLimitExceededError ||
          error instanceof CallLimitExceededError
        ) {
          this.setStatus("blocked", error.code);
          await this.logOnce();
          throw attachUsage(error, this.snapshotUsage());
        }

        const canRetry = attempt < maxRetries;

        if (canRetry) {
          this.usage.retries += 1;
          continue;
        }

        this.setStatus("failed");
        await this.logOnce();

        if (error instanceof GuardError) {
          throw attachUsage(error, this.snapshotUsage());
        }

        throw error;
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
