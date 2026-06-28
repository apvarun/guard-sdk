import type { GuardCallContext, GuardConfig, GuardResult, GuardRun, GuardStreamRun } from "./types.js";
/**
 * Enforces the limits that are knowable before a call runs: a zero/exceeded
 * `maxCalls` and an already-exhausted per-user budget baseline. Streaming
 * adapters create the underlying request outside `guard.run`, so they call
 * this first to avoid initiating (and paying for) a request that a fresh
 * `guard.run` would have blocked pre-call. Throws the matching GuardError.
 */
export declare function assertPreCallLimits(config: GuardConfig): Promise<void>;
/**
 * Builds an AbortSignal that fires when `timeoutMs` elapses or `config.signal`
 * aborts, returning a `dispose` that clears the timer and listeners. Streaming
 * adapters create their request outside `guard.run` (where `timeoutMs` is
 * normally enforced via the call context signal), so they use this to keep
 * timeout-based cancellation working for in-flight streams. Returns
 * `signal: undefined` when neither a timeout nor an external signal is set.
 */
export declare function createGuardAbortSignal(config: GuardConfig): {
    signal: AbortSignal | undefined;
    dispose: () => void;
};
export declare function createGuardStreamRun(config: GuardConfig): Promise<GuardStreamRun>;
export declare const guard: {
    run<T>(fn: (ctx: GuardCallContext) => Promise<T>, config?: GuardConfig): Promise<GuardResult<T>>;
    createRun(config?: GuardConfig): GuardRun;
};
