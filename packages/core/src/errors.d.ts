import type { GuardUsage } from "./types.js";
export declare class GuardError extends Error {
    readonly code: string;
    usage?: GuardUsage;
    constructor(code: string, message: string, usage?: GuardUsage, cause?: unknown);
}
export declare class BudgetExceededError extends GuardError {
    constructor(message?: string, usage?: GuardUsage);
}
export declare class TokenLimitExceededError extends GuardError {
    constructor(message?: string, usage?: GuardUsage);
}
export declare class CallLimitExceededError extends GuardError {
    constructor(message?: string, usage?: GuardUsage);
}
export declare class TimeoutError extends GuardError {
    constructor(message?: string, usage?: GuardUsage);
}
export declare class GuardConfigError extends GuardError {
    /** The configuration field that failed validation, when known. */
    readonly field?: string;
    constructor(message?: string, field?: string);
}
