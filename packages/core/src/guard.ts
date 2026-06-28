import { getModelPricing } from "@guard-sdk/pricing";
import {
  BudgetExceededError,
  CallLimitExceededError,
  GuardError,
  TimeoutError,
  TokenLimitExceededError,
} from "./errors.js";
import type {
  BudgetCommitOptions,
  BudgetCommitResult,
  BudgetSnapshot,
  GuardBudgetWindow,
  GuardCallContext,
  GuardConfig,
  GuardHooks,
  GuardPolicyReason,
  GuardResult,
  GuardRun,
  GuardStreamRun,
  GuardUsage,
  GuardWarning,
} from "./types.js";
import { validateGuardConfig } from "./validate.js";

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type LimitPhase = "pre" | "post";

const ZERO_BUDGET: BudgetSnapshot = { costUsd: 0, totalTokens: 0, calls: 0 };
const BUDGET_STORE_UNAVAILABLE_ERROR = "BUDGET_STORE_UNAVAILABLE";

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
  return {
    ...usage,
    wouldBlockReasons: usage.wouldBlockReasons ? [...usage.wouldBlockReasons] : undefined,
    warnings: usage.warnings ? [...usage.warnings] : undefined,
  };
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
    config.pricing?.getPricing(config.provider, config.model, {
      inputTokens: usage.inputTokens ?? usage.totalTokens,
      totalTokens: usage.totalTokens,
    }) ??
    getModelPricing(config.provider, config.model, {
      inputTokens: usage.inputTokens ?? usage.totalTokens,
      totalTokens: usage.totalTokens,
    });

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

function createBudgetStoreError(action: "read" | "write", key: string, cause: unknown): GuardError {
  const reason = cause instanceof Error ? cause.message : String(cause);

  return new GuardError(
    BUDGET_STORE_UNAVAILABLE_ERROR,
    `Failed to ${action} budget snapshot for "${key}": ${reason}`,
    undefined,
    cause,
  );
}

function budgetWindowBucket(window: GuardBudgetWindow | undefined): string {
  if (!window || window === "total") {
    return "total";
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");

  if (window === "month") {
    return `${year}-${month}`;
  }

  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveBudgetKey(config: GuardConfig): string | undefined {
  if (!config.budget) {
    return undefined;
  }

  const base = config.budgetKey ?? config.userId;

  if (!base) {
    return undefined;
  }

  return `${base}::${budgetWindowBucket(config.budgetWindow)}`;
}

async function loadBudgetBaseline(config: GuardConfig): Promise<BudgetSnapshot> {
  const key = resolveBudgetKey(config);

  if (!config.budget || !key) {
    return { ...ZERO_BUDGET };
  }

  try {
    const snapshot = await config.budget.get(key);
    return {
      costUsd: snapshot.costUsd ?? 0,
      totalTokens: snapshot.totalTokens ?? 0,
      calls: snapshot.calls ?? 0,
    };
  } catch (error) {
    throw createBudgetStoreError("read", key, error);
  }
}

function addBudgetSnapshots(current: BudgetSnapshot, delta: BudgetSnapshot): BudgetSnapshot {
  return {
    costUsd: current.costUsd + (delta.costUsd ?? 0),
    totalTokens: current.totalTokens + (delta.totalTokens ?? 0),
    calls: current.calls + (delta.calls ?? 0),
  };
}

function subtractBudgetSnapshots(total: BudgetSnapshot, persisted: BudgetSnapshot): BudgetSnapshot {
  return {
    costUsd: total.costUsd - persisted.costUsd,
    totalTokens: total.totalTokens - persisted.totalTokens,
    calls: total.calls - persisted.calls,
  };
}

function normalizeBudgetSnapshot(snapshot: BudgetSnapshot): BudgetSnapshot {
  return {
    costUsd: snapshot.costUsd ?? 0,
    totalTokens: snapshot.totalTokens ?? 0,
    calls: snapshot.calls ?? 0,
  };
}

async function commitBudget(
  config: GuardConfig,
  key: string,
  delta: BudgetSnapshot,
  options?: BudgetCommitOptions,
): Promise<BudgetCommitResult> {
  if (typeof config.budget?.commit !== "function") {
    throw new GuardError(
      BUDGET_STORE_UNAVAILABLE_ERROR,
      'Budget store does not support atomic "commit".',
    );
  }

  try {
    const result = await config.budget.commit(key, delta, options);

    return {
      snapshot: normalizeBudgetSnapshot(result.snapshot),
      rejected: result.rejected,
    };
  } catch (error) {
    throw createBudgetStoreError("write", key, error);
  }
}

function getPreCallLimitViolations(
  config: GuardConfig,
  usage: GuardUsage,
  baseline: BudgetSnapshot,
): GuardPolicyReason[] {
  const violations = new Set<GuardPolicyReason>();

  if (config.maxCalls !== undefined && usage.calls >= config.maxCalls) {
    violations.add("CALL_LIMIT_EXCEEDED");
  }

  if (config.maxUserCalls !== undefined && baseline.calls + usage.calls >= config.maxUserCalls) {
    violations.add("CALL_LIMIT_EXCEEDED");
  }

  if (config.maxTokens !== undefined && (usage.totalTokens ?? 0) >= config.maxTokens) {
    violations.add("TOKEN_LIMIT_EXCEEDED");
  }

  if (config.maxCostUsd !== undefined && (usage.estimatedCostUsd ?? 0) >= config.maxCostUsd) {
    violations.add("BUDGET_EXCEEDED");
  }

  if (
    config.maxUserTokens !== undefined &&
    baseline.totalTokens + (usage.totalTokens ?? 0) >= config.maxUserTokens
  ) {
    violations.add("TOKEN_LIMIT_EXCEEDED");
  }

  if (
    config.maxUserCostUsd !== undefined &&
    baseline.costUsd + (usage.estimatedCostUsd ?? 0) >= config.maxUserCostUsd
  ) {
    violations.add("BUDGET_EXCEEDED");
  }

  return [...violations];
}

function getPostCallLimitViolations(config: GuardConfig, usage: GuardUsage): GuardPolicyReason[] {
  const violations = new Set<GuardPolicyReason>();

  if (config.maxTokens !== undefined && (usage.totalTokens ?? 0) > config.maxTokens) {
    violations.add("TOKEN_LIMIT_EXCEEDED");
  }

  if (
    config.maxCostUsd !== undefined &&
    usage.estimatedCostUsd !== undefined &&
    usage.estimatedCostUsd > config.maxCostUsd
  ) {
    violations.add("BUDGET_EXCEEDED");
  }

  return [...violations];
}

function getPostBudgetLimitViolations(
  config: GuardConfig,
  snapshot: BudgetSnapshot,
): GuardPolicyReason[] {
  const violations = new Set<GuardPolicyReason>();

  if (config.maxUserCalls !== undefined && snapshot.calls > config.maxUserCalls) {
    violations.add("CALL_LIMIT_EXCEEDED");
  }

  if (config.maxUserTokens !== undefined && snapshot.totalTokens > config.maxUserTokens) {
    violations.add("TOKEN_LIMIT_EXCEEDED");
  }

  if (config.maxUserCostUsd !== undefined && snapshot.costUsd > config.maxUserCostUsd) {
    violations.add("BUDGET_EXCEEDED");
  }

  return [...violations];
}

function createPolicyError(
  reason: GuardPolicyReason,
  phase: LimitPhase,
  config: GuardConfig,
  usage: GuardUsage,
  baseline: BudgetSnapshot,
): GuardError {
  const verb = phase === "pre" ? "reached" : "exceeded";

  if (reason === "CALL_LIMIT_EXCEEDED") {
    const calls = usage.calls;
    const overRun =
      config.maxCalls !== undefined &&
      (phase === "pre" ? calls >= config.maxCalls : calls > config.maxCalls);

    if (overRun) {
      return new CallLimitExceededError(
        `Call limit ${verb}: ${calls} call(s) made, limit is ${config.maxCalls}.`,
      );
    }

    return new CallLimitExceededError(
      `Per-user call limit ${verb}: ${baseline.calls + calls} call(s) across runs, limit is ${config.maxUserCalls}.`,
    );
  }

  if (reason === "TOKEN_LIMIT_EXCEEDED") {
    const tokens = usage.totalTokens ?? 0;
    const overRun =
      config.maxTokens !== undefined &&
      (phase === "pre" ? tokens >= config.maxTokens : tokens > config.maxTokens);

    if (overRun) {
      return new TokenLimitExceededError(
        `Token limit ${verb}: ${tokens} token(s), limit is ${config.maxTokens}.`,
      );
    }

    return new TokenLimitExceededError(
      `Per-user token limit ${verb}: ${baseline.totalTokens + tokens} token(s) across runs, limit is ${config.maxUserTokens}.`,
    );
  }

  const cost = usage.estimatedCostUsd ?? 0;
  const overRun =
    config.maxCostUsd !== undefined &&
    (phase === "pre" ? cost >= config.maxCostUsd : cost > config.maxCostUsd);

  if (overRun) {
    return new BudgetExceededError(
      `Cost budget ${verb}: estimated $${cost.toFixed(6)}, limit is $${config.maxCostUsd}.`,
    );
  }

  return new BudgetExceededError(
    `Per-user cost budget ${verb}: estimated $${(baseline.costUsd + cost).toFixed(6)} across runs, limit is $${config.maxUserCostUsd}.`,
  );
}

function checkPreCallLimits(config: GuardConfig, usage: GuardUsage, baseline: BudgetSnapshot) {
  const violations = getPreCallLimitViolations(config, usage, baseline);

  if (violations[0]) {
    throw createPolicyError(violations[0], "pre", config, usage, baseline);
  }
}

function checkPostCallLimits(config: GuardConfig, usage: GuardUsage, baseline: BudgetSnapshot) {
  const violations = getPostCallLimitViolations(config, usage);

  if (violations[0]) {
    throw createPolicyError(violations[0], "post", config, usage, baseline);
  }
}

/**
 * Enforces the limits that are knowable before a call runs: a zero/exceeded
 * `maxCalls` and an already-exhausted per-user budget baseline. Streaming
 * adapters create the underlying request outside `guard.run`, so they call
 * this first to avoid initiating (and paying for) a request that a fresh
 * `guard.run` would have blocked pre-call. Throws the matching GuardError.
 */
export async function assertPreCallLimits(config: GuardConfig): Promise<void> {
  validateGuardConfig(config);

  if (isDryRunMode(config)) {
    return;
  }

  const baseline = await loadBudgetBaseline(config);
  const usage: GuardUsage = {
    runId: createRunId(),
    status: "success",
    name: config.name,
    userId: config.userId,
    provider: config.provider,
    model: config.model,
    calls: 0,
    retries: 0,
    durationMs: 0,
  };

  try {
    checkPreCallLimits(config, usage, baseline);
  } catch (error) {
    if (error instanceof GuardError) {
      throw attachUsage(error, usage);
    }

    throw error;
  }
}

function createAbortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;

  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(
    typeof reason === "string" ? reason : "Guard run was aborted before completion.",
  );
  error.name = "AbortError";
  return error;
}

async function executeWithTimeout<T>(
  fn: (ctx: GuardCallContext) => Promise<T>,
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  const linkExternalAbort = () => {
    if (!externalSignal) {
      return;
    }

    if (externalSignal.aborted) {
      controller.abort((externalSignal as { reason?: unknown }).reason);
      return;
    }

    const onAbort = () => controller.abort((externalSignal as { reason?: unknown }).reason);
    externalSignal.addEventListener("abort", onAbort, { once: true });
    cleanup.push(() => externalSignal.removeEventListener("abort", onAbort));
  };

  linkExternalAbort();

  const ctx: GuardCallContext = { signal: controller.signal };
  const racers: Array<Promise<T>> = [fn(ctx)];

  if (timeoutMs && timeoutMs > 0) {
    racers.push(
      new Promise<T>((_, reject) => {
        const timeoutId = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(`Call exceeded timeout of ${timeoutMs}ms`));
        }, timeoutMs);
        cleanup.push(() => clearTimeout(timeoutId));
      }),
    );
  }

  if (externalSignal) {
    racers.push(
      new Promise<T>((_, reject) => {
        if (externalSignal.aborted) {
          reject(createAbortError(externalSignal));
          return;
        }

        const onAbort = () => reject(createAbortError(externalSignal));
        externalSignal.addEventListener("abort", onAbort, { once: true });
        cleanup.push(() => externalSignal.removeEventListener("abort", onAbort));
      }),
    );
  }

  try {
    return await Promise.race(racers);
  } finally {
    for (const dispose of cleanup) {
      dispose();
    }
  }
}

/**
 * Builds an AbortSignal that fires when `timeoutMs` elapses or `config.signal`
 * aborts, returning a `dispose` that clears the timer and listeners. Streaming
 * adapters create their request outside `guard.run` (where `timeoutMs` is
 * normally enforced via the call context signal), so they use this to keep
 * timeout-based cancellation working for in-flight streams. Returns
 * `signal: undefined` when neither a timeout nor an external signal is set.
 */
export function createGuardAbortSignal(config: GuardConfig): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  const { timeoutMs, signal: external } = config;
  const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;

  if (!hasTimeout && !external) {
    return { signal: undefined, dispose: () => {} };
  }

  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  if (external) {
    if (external.aborted) {
      controller.abort((external as { reason?: unknown }).reason);
    } else {
      const onAbort = () => controller.abort((external as { reason?: unknown }).reason);
      external.addEventListener("abort", onAbort, { once: true });
      cleanup.push(() => external.removeEventListener("abort", onAbort));
    }
  }

  if (hasTimeout) {
    const timeoutId = setTimeout(() => {
      controller.abort(new TimeoutError(`Call exceeded timeout of ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup.push(() => clearTimeout(timeoutId));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const fn of cleanup) {
        fn();
      }
    },
  };
}

export async function createGuardStreamRun(config: GuardConfig): Promise<GuardStreamRun> {
  validateGuardConfig(config);

  const run = new GuardRunController(config);
  await run.startStream();

  return {
    finish: <T>(fn: () => Promise<T> | T) => run.finishStream(fn),
    summary: () => run.summary(),
  };
}

class GuardRunController {
  private readonly startedAt = Date.now();
  private readonly usage: GuardUsage;
  private readonly config: GuardConfig;
  private readonly budgetKey?: string;
  private budgetBaseline: BudgetSnapshot = { ...ZERO_BUDGET };
  private persistedBudget: BudgetSnapshot = { ...ZERO_BUDGET };
  private budgetLoaded = false;
  private started = false;
  private finalEmitted = false;
  private warnedCost = false;
  private warnedTokens = false;

  constructor(config: GuardConfig) {
    this.config = config;
    this.budgetKey = resolveBudgetKey(config);
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

  private async fireHook<K extends keyof GuardHooks>(
    name: K,
    ...extra: K extends "onBlock" ? [GuardError] : K extends "onWarn" ? [GuardWarning] : []
  ) {
    const hook = this.config.hooks?.[name];

    if (typeof hook !== "function") {
      return;
    }

    try {
      await (hook as (usage: GuardUsage, ...rest: unknown[]) => unknown)(
        this.snapshotUsage(),
        ...extra,
      );
    } catch {
      // Hook failures must never break the guarded call.
    }
  }

  private async ensureBudgetLoaded() {
    if (this.budgetLoaded) {
      return;
    }

    this.budgetLoaded = true;
    this.budgetBaseline = await loadBudgetBaseline(this.config);
  }

  private async persistBudget() {
    if (!this.config.budget || !this.budgetKey) {
      return undefined;
    }

    // Persist only the amount not yet written. Tracking what has already been
    // persisted lets this run eagerly after each successful call (so
    // `createRun`, whose success path never awaits finalization, still records
    // spend) and again at finalization, without double-counting.
    const total: BudgetSnapshot = {
      costUsd: this.usage.estimatedCostUsd ?? 0,
      totalTokens: this.usage.totalTokens ?? 0,
      calls: this.usage.calls,
    };

    const delta = subtractBudgetSnapshots(total, this.persistedBudget);

    if (delta.costUsd === 0 && delta.totalTokens === 0 && delta.calls === 0) {
      return addBudgetSnapshots(this.budgetBaseline, this.persistedBudget);
    }

    try {
      if (typeof this.config.budget.commit === "function") {
        const result = await commitBudget(this.config, this.budgetKey, delta);

        if (!result.rejected) {
          this.persistedBudget = total;
        }

        return result.snapshot;
      }

      await this.config.budget.add(this.budgetKey, delta);
      this.persistedBudget = total;
      return addBudgetSnapshots(this.budgetBaseline, this.persistedBudget);
    } catch (error) {
      if (error instanceof GuardError) {
        throw error;
      }

      throw createBudgetStoreError("write", this.budgetKey, error);
    }
  }

  private async reserveUserCall() {
    if (
      isDryRunMode(this.config) ||
      this.config.maxUserCalls === undefined ||
      !this.config.budget ||
      !this.budgetKey
    ) {
      return;
    }

    const delta: BudgetSnapshot = { costUsd: 0, totalTokens: 0, calls: 1 };
    const result = await commitBudget(this.config, this.budgetKey, delta, {
      rejectIfExceeded: { calls: this.config.maxUserCalls },
    });

    if (result.rejected) {
      const error = new CallLimitExceededError(
        `Per-user call limit reached: ${result.snapshot.calls} call(s) across runs, limit is ${this.config.maxUserCalls}.`,
      );
      this.setStatus("blocked", error.code);
      const blocked = attachUsage(error, this.snapshotUsage());
      await this.fireHook("onBlock", blocked);
      await this.emitFinalOnce();
      throw blocked;
    }

    this.persistedBudget = {
      ...this.persistedBudget,
      calls: this.persistedBudget.calls + 1,
    };
  }

  private async emitFinalOnce() {
    if (this.finalEmitted) {
      return;
    }

    this.finalEmitted = true;

    await this.persistBudget();
    await this.fireHook("onFinish");

    if (this.config.logger) {
      try {
        await this.config.logger.log(this.snapshotUsage());
      } catch {
        // Logger failures must not break the guarded call.
      }
    }
  }

  private async evaluateWarnings(snapshot?: BudgetSnapshot) {
    const warnings: GuardWarning[] = [];
    const currentCost = this.usage.estimatedCostUsd ?? 0;
    const warningCost = Math.max(currentCost, snapshot?.costUsd ?? 0);
    const currentTokens = this.usage.totalTokens ?? 0;
    const warningTokens = Math.max(currentTokens, snapshot?.totalTokens ?? 0);

    if (
      !this.warnedCost &&
      this.config.warnAtCostUsd !== undefined &&
      warningCost >= this.config.warnAtCostUsd
    ) {
      this.warnedCost = true;
      warnings.push({
        reason: "COST_WARNING",
        message: `Estimated cost $${warningCost.toFixed(6)} reached warning threshold $${this.config.warnAtCostUsd}.`,
      });
    }

    if (
      !this.warnedTokens &&
      this.config.warnAtTokens !== undefined &&
      warningTokens >= this.config.warnAtTokens
    ) {
      this.warnedTokens = true;
      warnings.push({
        reason: "TOKEN_WARNING",
        message: `Total tokens ${warningTokens} reached warning threshold ${this.config.warnAtTokens}.`,
      });
    }

    if (warnings.length === 0) {
      return;
    }

    this.usage.warnings = [...(this.usage.warnings ?? []), ...warnings];

    for (const warning of warnings) {
      await this.fireHook("onWarn", warning);
    }
  }

  private async handlePreCallLimits() {
    const usageSnapshot = this.snapshotUsage();

    if (isDryRunMode(this.config)) {
      this.recordWouldBlockReasons(
        getPreCallLimitViolations(this.config, usageSnapshot, this.budgetBaseline),
      );
      return;
    }

    try {
      checkPreCallLimits(this.config, usageSnapshot, this.budgetBaseline);
    } catch (error) {
      if (
        error instanceof BudgetExceededError ||
        error instanceof TokenLimitExceededError ||
        error instanceof CallLimitExceededError
      ) {
        this.setStatus("blocked", error.code);
        const blocked = attachUsage(error, this.snapshotUsage());
        await this.fireHook("onBlock", blocked);
        await this.emitFinalOnce();
        throw blocked;
      }

      throw error;
    }
  }

  private async executeSingleAttempt<T>(fn: (ctx: GuardCallContext) => Promise<T>): Promise<{
    data: T;
    tokenUsage: TokenUsage;
  }> {
    const data = await executeWithTimeout(fn, this.config.timeoutMs, this.config.signal);
    const tokenUsage =
      extractProviderUsage(data) ?? (await estimateTokensFromValue(data, this.config.tokenizer));

    return { data, tokenUsage };
  }

  private async processSuccessfulAttempt(tokenUsage: TokenUsage) {
    mergeTokenUsage(this.usage, tokenUsage);

    const estimatedCostUsd = estimateCostUsd(this.config, this.usage);

    if (estimatedCostUsd !== undefined) {
      this.usage.estimatedCostUsd = estimatedCostUsd;
    }

    const usageSnapshot = this.snapshotUsage();

    if (isDryRunMode(this.config)) {
      this.recordWouldBlockReasons([
        ...getPostCallLimitViolations(this.config, usageSnapshot),
        ...getPostBudgetLimitViolations(
          this.config,
          addBudgetSnapshots(this.budgetBaseline, {
            costUsd: usageSnapshot.estimatedCostUsd ?? 0,
            totalTokens: usageSnapshot.totalTokens ?? 0,
            calls: usageSnapshot.calls,
          }),
        ),
      ]);
      await this.evaluateWarnings();
    } else {
      checkPostCallLimits(this.config, usageSnapshot, this.budgetBaseline);
      const budgetSnapshot = await this.persistBudget();
      await this.evaluateWarnings(budgetSnapshot);
      const budgetViolations = budgetSnapshot
        ? getPostBudgetLimitViolations(this.config, budgetSnapshot)
        : [];

      if (budgetViolations[0]) {
        throw createPolicyError(budgetViolations[0], "post", this.config, usageSnapshot, {
          costUsd: budgetSnapshot?.costUsd ?? this.budgetBaseline.costUsd,
          totalTokens: budgetSnapshot?.totalTokens ?? this.budgetBaseline.totalTokens,
          calls: (budgetSnapshot?.calls ?? this.budgetBaseline.calls) - usageSnapshot.calls,
        });
      }
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
      await this.emitFinalOnce();
      return {
        shouldRetry: false,
        errorToThrow: new TimeoutError(error.message, this.snapshotUsage()),
      };
    }

    if (error instanceof GuardError && error.code === BUDGET_STORE_UNAVAILABLE_ERROR) {
      this.setStatus("failed");
      return {
        shouldRetry: false,
        errorToThrow: attachUsage(error, this.snapshotUsage()),
      };
    }

    if (
      error instanceof BudgetExceededError ||
      error instanceof TokenLimitExceededError ||
      error instanceof CallLimitExceededError
    ) {
      this.setStatus("blocked", error.code);
      const blocked = attachUsage(error, this.snapshotUsage());
      await this.fireHook("onBlock", blocked);
      await this.emitFinalOnce();
      return {
        shouldRetry: false,
        errorToThrow: blocked,
      };
    }

    const canRetry = attempt < maxRetries;

    if (canRetry) {
      this.usage.retries += 1;
      await this.fireHook("onRetry");
      return { shouldRetry: true }; // Signal to retry
    }

    this.setStatus("failed");
    await this.emitFinalOnce();

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

  private async beginCall() {
    if (!this.started) {
      this.started = true;
      await this.fireHook("onStart");
    }

    await this.ensureBudgetLoaded();
    await this.handlePreCallLimits();
    await this.reserveUserCall();

    this.usage.calls += 1;
    await this.fireHook("onCall");
  }

  async call<T>(_name: string, fn: (ctx: GuardCallContext) => Promise<T>): Promise<T> {
    await this.beginCall();

    const maxRetries = Math.max(0, this.config.maxRetries ?? 0);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const { data, tokenUsage } = await this.executeSingleAttempt(fn);
        await this.processSuccessfulAttempt(tokenUsage);

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
    await this.emitFinalOnce();
    throw new GuardError("UNREACHABLE", "Unexpected guard runtime state", this.snapshotUsage());
  }

  async startStream(): Promise<void> {
    await this.beginCall();
  }

  async finishStream<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      const data = await fn();
      const tokenUsage =
        extractProviderUsage(data) ?? (await estimateTokensFromValue(data, this.config.tokenizer));
      await this.processSuccessfulAttempt(tokenUsage);
      await this.finishSuccessLog();
      return data;
    } catch (error) {
      const result = await this.handleAttemptError(error, 0, 0);

      if (result.errorToThrow) {
        throw result.errorToThrow;
      }

      throw error;
    }
  }

  summary(): GuardUsage {
    if (this.usage.status === "success") {
      void this.emitFinalOnce();
    }

    return this.snapshotUsage();
  }

  async finishSuccessLog() {
    if (this.usage.status === "success") {
      await this.emitFinalOnce();
    }
  }
}

export const guard = {
  async run<T>(
    fn: (ctx: GuardCallContext) => Promise<T>,
    config: GuardConfig = {},
  ): Promise<GuardResult<T>> {
    validateGuardConfig(config);

    const run = new GuardRunController(config);
    const data = await run.call(config.name ?? "run", fn);
    await run.finishSuccessLog();

    return {
      data,
      usage: run.summary(),
    };
  },

  createRun(config: GuardConfig = {}): GuardRun {
    validateGuardConfig(config);

    const run = new GuardRunController(config);

    return {
      call: <T>(name: string, fn: (ctx: GuardCallContext) => Promise<T>) => run.call(name, fn),
      summary: () => run.summary(),
    };
  },
};
