import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  BudgetExceededError,
  CallLimitExceededError,
  TimeoutError,
  createMemoryLogger,
  createJsonFileLogger,
  createTempDir,
  createTempDbPath,
} from "@guard-sdk/core";
import { createSQLiteLogger, readUsageReport } from "../../storage-sqlite/src/index.ts";
import { createPricingResolver } from "@guard-sdk/pricing";
import { createOpenAIGuard } from "../src/index.ts";

test("returns raw chat completion response", async () => {
  const response = {
    id: "chatcmpl_1",
    usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
  };

  const client = {
    chat: {
      completions: {
        create: async () => response,
      },
    },
  };

  const guarded = createOpenAIGuard(client);
  const result = (await guarded.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [],
  })) as { usage: { total_tokens: number } };

  expect(result).toBe(response);
});

test("merges default config with per-call overrides", async () => {
  const logger = createMemoryLogger();

  const client = {
    chat: {
      completions: {
        create: async () => ({
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      },
    },
  };

  const guarded = createOpenAIGuard(client, {
    name: "default-name",
    maxCalls: 0,
    model: "default-model",
    logger,
  });

  await guarded.chat.completions.create(
    {
      model: "gpt-4.1-mini",
      messages: [],
    },
    {
      maxCalls: 1,
      name: "override-name",
    },
  );

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.name).toBe("override-name");
  expect(logs[0]?.provider).toBe("openai");
  expect(logs[0]?.model).toBe("gpt-4.1-mini");
});

test("propagates call-limit guard errors unchanged", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({ usage: { total_tokens: 1 } }),
      },
    },
  };

  const guarded = createOpenAIGuard(client, { maxCalls: 0 });

  await expect(
    guarded.chat.completions.create({ model: "gpt-4.1-mini", messages: [] }),
  ).rejects.toBeInstanceOf(CallLimitExceededError);
});

test("retries transient failures based on maxRetries", async () => {
  let attempts = 0;

  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("temporary");
          }

          return { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        },
      },
    },
  };

  const guarded = createOpenAIGuard(client, { maxRetries: 2 });

  const result = (await guarded.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [],
  })) as { usage: { total_tokens: number } };
  expect(result.usage.total_tokens).toBe(15);
  expect(attempts).toBe(3);
});

test("enforces budget using model from params", async () => {
  const pricing = createPricingResolver([
    {
      provider: "openai",
      model: "gpt-test",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    },
  ]);

  const client = {
    chat: {
      completions: {
        create: async () => ({
          usage: {
            prompt_tokens: 1_000_000,
            completion_tokens: 0,
            total_tokens: 1_000_000,
          },
        }),
      },
    },
  };

  const guarded = createOpenAIGuard(client, {
    pricing,
    maxCostUsd: 0.5,
  });

  await expect(
    guarded.chat.completions.create({ model: "gpt-test", messages: [] }),
  ).rejects.toBeInstanceOf(BudgetExceededError);
});

test("timeout errors are not retried", async () => {
  let attempts = 0;

  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
        },
      },
    },
  };

  const guarded = createOpenAIGuard(client, {
    timeoutMs: 5,
    maxRetries: 5,
  });

  await expect(
    guarded.chat.completions.create({ model: "gpt-4.1-mini", messages: [] }),
  ).rejects.toBeInstanceOf(TimeoutError);

  expect(attempts).toBe(1);
});

test("supports json file logger in adapter config", async () => {
  const [directory, cleanup] = await createTempDir("guard-sdk-openai-");
  const filePath = join(directory, "usage.jsonl");

  try {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          }),
        },
      },
    };

    const guarded = createOpenAIGuard(client, {
      logger: createJsonFileLogger({ filePath }),
      name: "openai-file-log",
    });

    await guarded.chat.completions.create({ model: "gpt-4.1-mini", messages: [] });

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);

    const log = JSON.parse(lines[0] ?? "{}") as {
      name?: string;
      provider?: string;
      model?: string;
      status?: string;
    };

    expect(log.name).toBe("openai-file-log");
    expect(log.provider).toBe("openai");
    expect(log.model).toBe("gpt-4.1-mini");
    expect(log.status).toBe("success");
  } finally {
    await cleanup();
  }
});

test("supports sqlite logger in adapter config", async () => {
  const [dbPath, cleanup] = await createTempDbPath("guard-sdk-openai-");

  try {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
    };

    const logger = await createSQLiteLogger({ dbPath });
    const guarded = createOpenAIGuard(client, {
      logger,
      name: "openai-sqlite-log",
    });

    await guarded.chat.completions.create({ model: "gpt-4.1-mini", messages: [] });

    const report = readUsageReport({ dbPath });
    expect(report.totalRuns).toBe(1);
    expect(report.totalCalls).toBe(1);
    expect(report.mostExpensiveRun?.name).toBe("openai-sqlite-log");
  } finally {
    await cleanup();
  }
});
