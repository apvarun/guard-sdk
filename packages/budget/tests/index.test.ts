import { expect, test } from "vite-plus/test";
import { TokenLimitExceededError, guard } from "@guard-sdk/core";
import { createMemoryBudgetStore } from "../src/index.ts";

test("memory budget store accumulates per key", () => {
  const store = createMemoryBudgetStore();

  store.add("user-1", { costUsd: 0.5, totalTokens: 100, calls: 1 });
  store.add("user-1", { costUsd: 0.25, totalTokens: 50, calls: 1 });

  expect(store.get("user-1")).toEqual({ costUsd: 0.75, totalTokens: 150, calls: 2 });
  expect(store.get("unknown")).toEqual({ costUsd: 0, totalTokens: 0, calls: 0 });
});

test("memory budget store reset and keys", () => {
  const store = createMemoryBudgetStore();
  store.add("a", { costUsd: 1, totalTokens: 1, calls: 1 });
  store.add("b", { costUsd: 1, totalTokens: 1, calls: 1 });

  expect(store.keys().sort()).toEqual(["a", "b"]);

  store.reset("a");
  expect(store.keys()).toEqual(["b"]);

  store.reset();
  expect(store.keys()).toEqual([]);
});

test("memory budget store commit can reject without mutating", () => {
  const store = createMemoryBudgetStore();

  store.add("user-1", { costUsd: 0, totalTokens: 0, calls: 1 });

  expect(
    store.commit(
      "user-1",
      { costUsd: 0, totalTokens: 0, calls: 1 },
      {
        rejectIfExceeded: { calls: 1 },
      },
    ),
  ).toEqual({
    snapshot: { costUsd: 0, totalTokens: 0, calls: 1 },
    rejected: true,
  });
  expect(store.get("user-1")).toEqual({ costUsd: 0, totalTokens: 0, calls: 1 });
});

test("guard enforces cumulative per-user token budgets via the memory store", async () => {
  const budget = createMemoryBudgetStore();
  const config = { userId: "user-1", budget, maxUserTokens: 10 };

  await guard.run(async () => ({ usage: { total_tokens: 8 } }), config);
  expect(budget.peek("user-1::total").totalTokens).toBe(8);

  await expect(
    guard.run(async () => ({ usage: { total_tokens: 8 } }), config),
  ).rejects.toBeInstanceOf(TokenLimitExceededError);
});

test("budget keys are bucketed by window", async () => {
  const budget = createMemoryBudgetStore();

  await guard.run(async () => ({ usage: { total_tokens: 5 } }), {
    userId: "user-2",
    budget,
    budgetWindow: "month",
  });

  const key = budget.keys()[0];
  expect(key).toMatch(/^user-2::\d{4}-\d{2}$/);
});
