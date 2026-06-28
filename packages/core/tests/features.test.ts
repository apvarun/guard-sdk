import { expect, test } from "vite-plus/test";
import { createPricingResolver } from "@guard-sdk/pricing";
import type { BudgetSnapshot } from "../src/index.ts";
import type { BudgetCommitOptions, BudgetCommitResult } from "../src/index.ts";
import {
  BudgetExceededError,
  CallLimitExceededError,
  GuardConfigError,
  TimeoutError,
  TokenLimitExceededError,
  assertPreCallLimits,
  createGuardAbortSignal,
  guard,
  validateGuardConfig,
} from "../src/index.ts";

function createTestBudgetStore(): {
  get: (key: string) => BudgetSnapshot;
  add: (key: string, delta: BudgetSnapshot) => void;
  commit: (key: string, delta: BudgetSnapshot, options?: BudgetCommitOptions) => BudgetCommitResult;
  peek: (key: string) => BudgetSnapshot;
} {
  const entries = new Map<string, BudgetSnapshot>();
  const zero: BudgetSnapshot = { costUsd: 0, totalTokens: 0, calls: 0 };

  return {
    get(key) {
      return { ...(entries.get(key) ?? zero) };
    },
    add(key, delta) {
      const current = entries.get(key) ?? { ...zero };
      entries.set(key, {
        costUsd: current.costUsd + delta.costUsd,
        totalTokens: current.totalTokens + delta.totalTokens,
        calls: current.calls + delta.calls,
      });
    },
    commit(key, delta, options) {
      const current = entries.get(key) ?? { ...zero };
      const next = {
        costUsd: current.costUsd + delta.costUsd,
        totalTokens: current.totalTokens + delta.totalTokens,
        calls: current.calls + delta.calls,
      };

      if (
        (options?.rejectIfExceeded?.costUsd !== undefined &&
          next.costUsd > options.rejectIfExceeded.costUsd) ||
        (options?.rejectIfExceeded?.totalTokens !== undefined &&
          next.totalTokens > options.rejectIfExceeded.totalTokens) ||
        (options?.rejectIfExceeded?.calls !== undefined &&
          next.calls > options.rejectIfExceeded.calls)
      ) {
        return { snapshot: { ...current }, rejected: true };
      }

      entries.set(key, next);
      return { snapshot: { ...next }, rejected: false };
    },
    peek(key) {
      return { ...(entries.get(key) ?? zero) };
    },
  };
}

// --- Config validation ---

test("validateGuardConfig rejects negative numeric limits", () => {
  expect(() => validateGuardConfig({ maxCostUsd: -1 })).toThrow(GuardConfigError);
  expect(() => validateGuardConfig({ maxCostUsd: -1 })).toThrow(/maxCostUsd/);
});

test("validateGuardConfig rejects non-integer counts and bad mode", () => {
  expect(() => validateGuardConfig({ maxCalls: 1.5 })).toThrow(/maxCalls.*integer/);
  expect(() => validateGuardConfig({ mode: "loose" as never })).toThrow(/mode/);
});

test("validateGuardConfig rejects warn thresholds above their hard limit", () => {
  expect(() => validateGuardConfig({ maxCostUsd: 1, warnAtCostUsd: 2 })).toThrow(/warnAtCostUsd/);
});

test("validateGuardConfig rejects invalid budget windows and cumulative warning gaps", () => {
  const budget = createTestBudgetStore();

  expect(() => validateGuardConfig({ budgetWindow: "week" as never })).toThrow(/budgetWindow/);
  expect(() =>
    validateGuardConfig({ budget, userId: "u", maxUserTokens: 10, warnAtTokens: 11 }),
  ).toThrow(/warnAtTokens/);
  expect(() =>
    validateGuardConfig({ budget, userId: "u", maxUserCostUsd: 1, warnAtCostUsd: 2 }),
  ).toThrow(/warnAtCostUsd/);
});

test("validateGuardConfig requires a budget store for per-user limits", () => {
  expect(() => validateGuardConfig({ maxUserCostUsd: 5 })).toThrow(/budget/);
});

test("validateGuardConfig requires atomic commit for cumulative limits", () => {
  const budget = {
    get() {
      return { costUsd: 0, totalTokens: 0, calls: 0 };
    },
    add() {},
  };

  expect(() => validateGuardConfig({ budget, userId: "u", maxUserTokens: 5 })).toThrow(/commit/);
});

test("guard.run validates config before running", async () => {
  await expect(guard.run(async () => "ok", { timeoutMs: -5 })).rejects.toBeInstanceOf(
    GuardConfigError,
  );
});

// --- Enriched error messages ---

test("blocked errors include actionable detail", async () => {
  await expect(guard.run(async () => "never", { maxCalls: 0 })).rejects.toThrow(
    /Call limit reached: 0 call\(s\) made, limit is 0\./,
  );
});

// --- Lifecycle hooks ---

test("hooks fire once at their lifecycle points", async () => {
  const events: string[] = [];

  await guard.run(async () => "ok", {
    hooks: {
      onStart: () => {
        events.push("start");
      },
      onCall: () => {
        events.push("call");
      },
      onFinish: () => {
        events.push("finish");
      },
    },
  });

  expect(events).toEqual(["start", "call", "finish"]);
});

test("onRetry fires per retry and onBlock fires on a blocked run", async () => {
  let retries = 0;
  let blockedCode: string | undefined;

  await guard.run(
    async () => {
      if (retries < 1) {
        throw new Error("retry");
      }

      return "ok";
    },
    {
      maxRetries: 2,
      hooks: {
        onRetry: () => {
          retries += 1;
        },
      },
    },
  );
  expect(retries).toBe(1);

  await expect(
    guard.run(async () => "never", {
      maxCalls: 0,
      hooks: {
        onBlock: (_usage, error) => {
          blockedCode = error.code;
        },
      },
    }),
  ).rejects.toBeInstanceOf(CallLimitExceededError);
  expect(blockedCode).toBe("CALL_LIMIT_EXCEEDED");
});

test("a throwing hook never breaks the guarded call", async () => {
  const { data } = await guard.run(async () => "ok", {
    hooks: {
      onFinish: () => {
        throw new Error("hook boom");
      },
    },
  });

  expect(data).toBe("ok");
});

// --- Soft warnings ---

test("warnAtTokens emits a non-blocking warning and fires onWarn", async () => {
  const warned: string[] = [];

  const { usage } = await guard.run(async () => ({ usage: { total_tokens: 50 } }), {
    warnAtTokens: 10,
    hooks: {
      onWarn: (_usage, warning) => {
        warned.push(warning.reason);
      },
    },
  });

  expect(usage.status).toBe("success");
  expect(usage.warnings?.[0]?.reason).toBe("TOKEN_WARNING");
  expect(warned).toEqual(["TOKEN_WARNING"]);
});

// --- AbortSignal cancellation ---

test("timeout aborts the call signal", async () => {
  let captured: AbortSignal | undefined;

  await expect(
    guard.run(
      async ({ signal }) => {
        captured = signal;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "late";
      },
      { timeoutMs: 5 },
    ),
  ).rejects.toBeInstanceOf(TimeoutError);

  expect(captured?.aborted).toBe(true);
});

test("an external signal aborts an in-flight run", async () => {
  const controller = new AbortController();

  const pending = guard.run(
    ({ signal }) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
      }),
    { signal: controller.signal, maxRetries: 0 },
  );

  controller.abort();

  await expect(pending).rejects.toThrow(/aborted/);
});

// --- Per-user cumulative budgets ---

test("per-user token budget blocks once cumulative usage exceeds the limit", async () => {
  const budget = createTestBudgetStore();
  const config = { userId: "user-1", budget, maxUserTokens: 10 };

  const first = await guard.run(async () => ({ usage: { total_tokens: 8 } }), config);
  expect(first.usage.status).toBe("success");

  await expect(
    guard.run(async () => ({ usage: { total_tokens: 8 } }), config),
  ).rejects.toBeInstanceOf(TokenLimitExceededError);
});

test("concurrent token commits record actual spend and reject the run that crosses the limit", async () => {
  const budget = createTestBudgetStore();
  const config = { userId: "user-concurrent", budget, maxUserTokens: 10 };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const runs = [
    guard.run(async () => {
      await gate;
      return { usage: { total_tokens: 8 } };
    }, config),
    guard.run(async () => {
      await gate;
      return { usage: { total_tokens: 8 } };
    }, config),
  ];

  release();
  const results = await Promise.allSettled(runs);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(budget.peek("user-concurrent::total")).toEqual({
    costUsd: 0,
    totalTokens: 16,
    calls: 2,
  });
});

test("maxUserCalls reserves atomically before provider execution", async () => {
  const budget = createTestBudgetStore();
  const config = { userId: "user-calls", budget, maxUserCalls: 1 };
  let executions = 0;

  const runs = [
    guard.run(async () => {
      executions += 1;
      return "ok";
    }, config),
    guard.run(async () => {
      executions += 1;
      return "ok";
    }, config),
  ];

  const results = await Promise.allSettled(runs);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(executions).toBe(1);
  expect(budget.peek("user-calls::total").calls).toBe(1);
});

test("cumulative warning thresholds fire when stored totals cross the threshold", async () => {
  const budget = createTestBudgetStore();
  const warnings: string[] = [];

  await guard.run(async () => ({ usage: { total_tokens: 6 } }), {
    userId: "warn-user",
    budget,
    maxUserTokens: 20,
    warnAtTokens: 10,
  });

  await guard.run(async () => ({ usage: { total_tokens: 5 } }), {
    userId: "warn-user",
    budget,
    maxUserTokens: 20,
    warnAtTokens: 10,
    hooks: {
      onWarn: (_usage, warning) => {
        warnings.push(warning.reason);
      },
    },
  });

  expect(warnings).toEqual(["TOKEN_WARNING"]);
});

test("per-user budget blocks pre-call when the baseline is already over budget", async () => {
  const budget = createTestBudgetStore();
  budget.add("user-2::total", { costUsd: 0, totalTokens: 20, calls: 1 });

  let executed = false;

  await expect(
    guard.run(
      async () => {
        executed = true;
        return "ok";
      },
      { userId: "user-2", budget, maxUserTokens: 10 },
    ),
  ).rejects.toBeInstanceOf(TokenLimitExceededError);

  expect(executed).toBe(false);
});

test("budget store read failures fail closed before the guarded call runs", async () => {
  const budget = {
    get() {
      throw new Error("budget read failed");
    },
    add() {
      throw new Error("unused");
    },
    commit() {
      throw new Error("unused");
    },
  };

  let executed = false;

  await expect(
    guard.run(
      async () => {
        executed = true;
        return "ok";
      },
      { userId: "user-err", budget, maxUserTokens: 10 },
    ),
  ).rejects.toMatchObject({
    code: "BUDGET_STORE_UNAVAILABLE",
  });

  expect(executed).toBe(false);
});

test("budget store write failures fail closed without retrying the guarded call", async () => {
  let attempts = 0;
  const budget = {
    get() {
      return { costUsd: 0, totalTokens: 0, calls: 0 };
    },
    add() {
      throw new Error("budget write failed");
    },
    commit() {
      throw new Error("budget write failed");
    },
  };

  await expect(
    guard.run(
      async () => {
        attempts += 1;
        return { usage: { total_tokens: 1 } };
      },
      { userId: "user-write-err", budget, maxUserTokens: 10 },
    ),
  ).rejects.toMatchObject({
    code: "BUDGET_STORE_UNAVAILABLE",
  });

  expect(attempts).toBe(1);
});

test("per-user cost budget accumulates across runs", async () => {
  const budget = createTestBudgetStore();
  const pricing = createPricingResolver([
    { provider: "openai", model: "gpt-test", inputPerMillionTokens: 1, outputPerMillionTokens: 1 },
  ]);
  const config = {
    userId: "user-3",
    budget,
    pricing,
    provider: "openai",
    model: "gpt-test",
    maxUserCostUsd: 0.75,
  };

  await guard.run(
    async () => ({
      usage: { prompt_tokens: 500_000, completion_tokens: 0, total_tokens: 500_000 },
    }),
    config,
  );
  expect(budget.peek("user-3::total").costUsd).toBeCloseTo(0.5, 6);

  await expect(
    guard.run(
      async () => ({
        usage: { prompt_tokens: 500_000, completion_tokens: 0, total_tokens: 500_000 },
      }),
      config,
    ),
  ).rejects.toBeInstanceOf(BudgetExceededError);
});

// --- createRun budget persistence ---

test("createRun records per-user spend on a successful call without summary()", async () => {
  const budget = createTestBudgetStore();
  const run = guard.createRun({ userId: "cr-1", budget, maxUserTokens: 100 });

  await run.call("c", async () => ({ usage: { total_tokens: 30 } }));

  // No summary() call — budget must already be durably recorded.
  expect(budget.peek("cr-1::total")).toEqual({ costUsd: 0, totalTokens: 30, calls: 1 });
});

test("createRun accumulates budget across calls without double counting", async () => {
  const budget = createTestBudgetStore();
  const run = guard.createRun({ userId: "cr-2", budget, maxUserTokens: 100 });

  await run.call("a", async () => ({ usage: { total_tokens: 30 } }));
  await run.call("b", async () => ({ usage: { total_tokens: 20 } }));
  run.summary();

  expect(budget.peek("cr-2::total")).toEqual({ costUsd: 0, totalTokens: 50, calls: 2 });
});

// --- Per-user limits require a key ---

test("validateGuardConfig requires userId or budgetKey for per-user limits", () => {
  const budget = createTestBudgetStore();
  expect(() => validateGuardConfig({ budget, maxUserTokens: 10 })).toThrow(/userId|budgetKey/);
  expect(() =>
    validateGuardConfig({ budget, budgetKey: "team-a", maxUserTokens: 10 }),
  ).not.toThrow();
});

test("validateGuardConfig rejects a fractional warnAtTokens", () => {
  expect(() => validateGuardConfig({ warnAtTokens: 10.5 })).toThrow(/warnAtTokens.*integer/);
});

// --- Pre-call gate for streaming adapters ---

test("assertPreCallLimits blocks when the budget baseline is already exhausted", async () => {
  const budget = createTestBudgetStore();
  budget.add("pre-1::total", { costUsd: 0, totalTokens: 50, calls: 1 });

  await expect(
    assertPreCallLimits({ userId: "pre-1", budget, maxUserTokens: 10 }),
  ).rejects.toBeInstanceOf(TokenLimitExceededError);
});

test("assertPreCallLimits blocks on a zero maxCalls and allows a fresh key", async () => {
  await expect(assertPreCallLimits({ maxCalls: 0 })).rejects.toBeInstanceOf(CallLimitExceededError);

  const budget = createTestBudgetStore();
  await expect(
    assertPreCallLimits({ userId: "pre-2", budget, maxUserTokens: 10 }),
  ).resolves.toBeUndefined();
});

// --- Timeout-aware abort signal helper ---

test("createGuardAbortSignal aborts on timeout and on an external signal", async () => {
  const timed = createGuardAbortSignal({ timeoutMs: 5 });
  expect(timed.signal?.aborted).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(timed.signal?.aborted).toBe(true);
  timed.dispose();

  const controller = new AbortController();
  const linked = createGuardAbortSignal({ signal: controller.signal });
  controller.abort();
  expect(linked.signal?.aborted).toBe(true);
  linked.dispose();

  expect(createGuardAbortSignal({}).signal).toBeUndefined();
});
