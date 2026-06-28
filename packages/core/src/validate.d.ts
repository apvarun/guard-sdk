import type { GuardConfig } from "./types.js";
/**
 * Validates a GuardConfig and throws a GuardConfigError with an
 * actionable message naming the offending field. Called once per run.
 */
export declare function validateGuardConfig(config: GuardConfig): void;
