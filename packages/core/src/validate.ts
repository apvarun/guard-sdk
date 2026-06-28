import { GuardConfigError } from "./errors.js";
import type { GuardBudgetWindow, GuardConfig, GuardMode } from "./types.js";

const VALID_MODES: readonly GuardMode[] = ["enforce", "dry-run"];
const VALID_BUDGET_WINDOWS: readonly GuardBudgetWindow[] = ["day", "month", "total"];

type NumericField = keyof Pick<
  GuardConfig,
  | "maxCostUsd"
  | "maxTokens"
  | "maxCalls"
  | "maxRetries"
  | "timeoutMs"
  | "warnAtCostUsd"
  | "warnAtTokens"
  | "maxUserCostUsd"
  | "maxUserTokens"
  | "maxUserCalls"
>;

const NON_NEGATIVE_FIELDS: readonly NumericField[] = [
  "maxCostUsd",
  "maxTokens",
  "maxCalls",
  "maxRetries",
  "timeoutMs",
  "warnAtCostUsd",
  "warnAtTokens",
  "maxUserCostUsd",
  "maxUserTokens",
  "maxUserCalls",
];

const INTEGER_FIELDS: readonly NumericField[] = [
  "maxCalls",
  "maxRetries",
  "maxTokens",
  "maxUserCalls",
  "maxUserTokens",
  "warnAtTokens",
];

function assertNonNegativeNumber(field: NumericField, value: number | undefined) {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GuardConfigError(
      `"${field}" must be a finite number. Received: ${String(value)}`,
      field,
    );
  }

  if (value < 0) {
    throw new GuardConfigError(
      `"${field}" must be greater than or equal to 0. Received: ${value}`,
      field,
    );
  }
}

function assertInteger(field: NumericField, value: number | undefined) {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value)) {
    throw new GuardConfigError(`"${field}" must be an integer. Received: ${value}`, field);
  }
}

function assertWarnBelowMax(
  warnField: NumericField,
  warnValue: number | undefined,
  maxField: NumericField,
  maxValue: number | undefined,
) {
  if (warnValue === undefined || maxValue === undefined) {
    return;
  }

  if (warnValue > maxValue) {
    throw new GuardConfigError(
      `"${warnField}" (${warnValue}) must be less than or equal to "${maxField}" (${maxValue}).`,
      warnField,
    );
  }
}

/**
 * Validates a GuardConfig and throws a GuardConfigError with an
 * actionable message naming the offending field. Called once per run.
 */
export function validateGuardConfig(config: GuardConfig): void {
  for (const field of NON_NEGATIVE_FIELDS) {
    assertNonNegativeNumber(field, config[field]);
  }

  for (const field of INTEGER_FIELDS) {
    assertInteger(field, config[field]);
  }

  if (config.mode !== undefined && !VALID_MODES.includes(config.mode)) {
    throw new GuardConfigError(
      `"mode" must be one of: ${VALID_MODES.join(", ")}. Received: ${String(config.mode)}`,
      "mode",
    );
  }

  if (config.budgetWindow !== undefined && !VALID_BUDGET_WINDOWS.includes(config.budgetWindow)) {
    throw new GuardConfigError(
      `"budgetWindow" must be one of: ${VALID_BUDGET_WINDOWS.join(", ")}. Received: ${String(config.budgetWindow)}`,
      "budgetWindow",
    );
  }

  assertWarnBelowMax("warnAtCostUsd", config.warnAtCostUsd, "maxCostUsd", config.maxCostUsd);
  assertWarnBelowMax(
    "warnAtCostUsd",
    config.warnAtCostUsd,
    "maxUserCostUsd",
    config.maxUserCostUsd,
  );
  assertWarnBelowMax("warnAtTokens", config.warnAtTokens, "maxTokens", config.maxTokens);
  assertWarnBelowMax("warnAtTokens", config.warnAtTokens, "maxUserTokens", config.maxUserTokens);

  const hasUserLimit =
    config.maxUserCostUsd !== undefined ||
    config.maxUserTokens !== undefined ||
    config.maxUserCalls !== undefined;

  if (hasUserLimit && config.budget === undefined) {
    throw new GuardConfigError(
      'Per-user limits ("maxUserCostUsd"/"maxUserTokens"/"maxUserCalls") require a "budget" store.',
      "budget",
    );
  }

  if (hasUserLimit && typeof config.budget?.commit !== "function") {
    throw new GuardConfigError(
      'Per-user limits ("maxUserCostUsd"/"maxUserTokens"/"maxUserCalls") require a budget store with an atomic "commit" method.',
      "budget",
    );
  }

  if (hasUserLimit && !config.userId && !config.budgetKey) {
    // Without a key, `resolveBudgetKey` returns undefined and the per-user
    // limit silently degrades to a per-run limit with no cross-run
    // persistence — reject it instead of pretending to enforce a budget.
    throw new GuardConfigError(
      'Per-user limits ("maxUserCostUsd"/"maxUserTokens"/"maxUserCalls") require a "userId" or "budgetKey" to track spend against.',
      "userId",
    );
  }
}
