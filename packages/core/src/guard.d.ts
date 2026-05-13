import type { GuardConfig, GuardResult, GuardRun } from "./types.js";
export declare const guard: {
  run<T>(fn: () => Promise<T>, config?: GuardConfig): Promise<GuardResult<T>>;
  createRun(config?: GuardConfig): GuardRun;
};
