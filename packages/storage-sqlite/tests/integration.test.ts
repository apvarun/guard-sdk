import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { TokenLimitExceededError } from "@guard-sdk/core";
import { createPricingResolver } from "../../pricing/src/index.ts";
import { createOpenAIGuard } from "../../openai/src/index.ts";
import { createSQLiteBudgetStore, createSQLiteLogger, readUsageReport } from "../src/index.ts";

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "guard-sdk-integration-"));
  return [dir, () => rm(dir, { recursive: true, force: true })] as const;
}

test("adapter → core → budget → SQLite logger → report works end to end", async () => {
  const [dir, cleanup] = await tempDir();

  try {
    const logger = await createSQLiteLogger({ dbPath: join(dir, "usage.db") });
    const budget = await createSQLiteBudgetStore({ dbPath: join(dir, "budget.db") });
    const pricing = createPricingResolver([
      {
        provider: "openai",
        model: "gpt-4o-mini",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 1,
      },
    ]);

    const client = {
      chat: {
        completions: {
          create: async () => ({
            id: "chatcmpl",
            usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
          }),
        },
      },
    };

    const guarded = createOpenAIGuard(client, {
      model: "gpt-4o-mini",
      userId: "user-1",
      logger,
      budget,
      pricing,
      maxUserTokens: 10,
    });

    await guarded.chat.completions.create({ messages: [] });

    // Second call pushes cumulative tokens (8 + 8) over the per-user limit.
    await expect(guarded.chat.completions.create({ messages: [] })).rejects.toBeInstanceOf(
      TokenLimitExceededError,
    );

    // Let the async SQLite logger drain.
    await new Promise((resolve) => setTimeout(resolve, 20));
    logger.close();
    budget.close();

    const report = readUsageReport({ dbPath: join(dir, "usage.db") });
    expect(report.totalRuns).toBe(2);
    expect(report.blockedCalls).toBe(1);
    expect(report.totalCalls).toBeGreaterThanOrEqual(1);
  } finally {
    await cleanup();
  }
});
