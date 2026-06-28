import { TokenLimitExceededError, guard } from "@guard-sdk/core";
import { createMemoryBudgetStore } from "@guard-sdk/budget";

// A budget store tracks spend across runs keyed by `userId`, so a single user
// can be capped regardless of how many individual runs they make. Swap
// `createMemoryBudgetStore()` for `createSQLiteBudgetStore({ dbPath })` from
// `@guard-sdk/storage-sqlite` to make the budget survive restarts.
const budget = createMemoryBudgetStore();

const config = {
  userId: "user-123",
  budget,
  maxUserTokens: 1000,
  // budgetWindow: "month", // bucket the budget per calendar month
};

async function callModel() {
  return { usage: { prompt_tokens: 400, completion_tokens: 200, total_tokens: 600 } };
}

// First run: 600 cumulative tokens — under the 1000 limit.
const first = await guard.run(callModel, config);
console.log("run 1:", first.usage.status, "tokens:", first.usage.totalTokens);

// Second run: 600 + 600 = 1200 cumulative tokens — over the limit, so blocked.
try {
  await guard.run(callModel, config);
} catch (error) {
  if (error instanceof TokenLimitExceededError) {
    console.log("run 2 blocked:", error.message);
  } else {
    throw error;
  }
}

console.log("cumulative usage for user-123:", budget.get("user-123::total"));
