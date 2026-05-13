import type { GuardUsage } from "./types.js";

export class GuardError extends Error {
  readonly code: string;
  usage?: GuardUsage;

  constructor(code: string, message: string, usage?: GuardUsage, cause?: unknown) {
    super(message);
    this.name = "GuardError";
    this.code = code;
    this.usage = usage;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class BudgetExceededError extends GuardError {
  constructor(message = "Guard budget limit exceeded", usage?: GuardUsage) {
    super("BUDGET_EXCEEDED", message, usage);
    this.name = "BudgetExceededError";
  }
}

export class TokenLimitExceededError extends GuardError {
  constructor(message = "Guard token limit exceeded", usage?: GuardUsage) {
    super("TOKEN_LIMIT_EXCEEDED", message, usage);
    this.name = "TokenLimitExceededError";
  }
}

export class CallLimitExceededError extends GuardError {
  constructor(message = "Guard call limit exceeded", usage?: GuardUsage) {
    super("CALL_LIMIT_EXCEEDED", message, usage);
    this.name = "CallLimitExceededError";
  }
}

export class TimeoutError extends GuardError {
  constructor(message = "Guard timeout exceeded", usage?: GuardUsage) {
    super("TIMEOUT", message, usage);
    this.name = "TimeoutError";
  }
}
