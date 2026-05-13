import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import {
  BudgetExceededError,
  CallLimitExceededError,
  TimeoutError,
  createMemoryLogger,
} from "@guard-sdk/core";
import { createPricingResolver } from "@guard-sdk/pricing";
import { createSQLiteLogger, readUsageReport } from "../../storage-sqlite/src/index.ts";
import { createVercelAIGuard } from "../src/index.ts";

test("generateText returns raw response", async () => {
  const response = {
    text: "hello",
    usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
  };

  const guarded = createVercelAIGuard({
    generateText: async () => response,
    streamText: () => ({
      text: Promise.resolve("hello"),
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
    }),
  });

  const result = await guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" });
  expect(result).toBe(response);
});

test("generateText supports usage field aliases", async () => {
  const logger = createMemoryLogger();

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "hello",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
      streamText: () => ({
        text: Promise.resolve("hello"),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    {
      logger,
      name: "vercel-generate",
    },
  );

  await guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" });

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.inputTokens).toBe(10);
  expect(logs[0]?.outputTokens).toBe(5);
  expect(logs[0]?.totalTokens).toBe(15);
  expect(logs[0]?.provider).toBe("vercel-ai");
});

test("merges default config with per-call overrides", async () => {
  const logger = createMemoryLogger();

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "ok",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
      streamText: () => ({
        text: Promise.resolve("ok"),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    {
      name: "default-name",
      logger,
      maxCalls: 0,
      model: "default-model",
    },
  );

  await guarded.generateText(
    {
      model: "gpt-4o-mini",
      prompt: "hi",
    },
    {
      maxCalls: 1,
      name: "override-name",
    },
  );

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.name).toBe("override-name");
  expect(logs[0]?.provider).toBe("vercel-ai");
  expect(logs[0]?.model).toBe("gpt-4o-mini");
});

test("propagates call-limit guard errors unchanged", async () => {
  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      streamText: () => ({
        text: Promise.resolve("ok"),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    { maxCalls: 0 },
  );

  await expect(guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" })).rejects.toBeInstanceOf(
    CallLimitExceededError,
  );
});

test("retries transient failures based on maxRetries", async () => {
  let attempts = 0;

  const guarded = createVercelAIGuard(
    {
      generateText: async () => {
        attempts += 1;

        if (attempts < 3) {
          throw new Error("temporary");
        }

        return {
          text: "ok",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
      streamText: () => ({
        text: Promise.resolve("ok"),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    { maxRetries: 2 },
  );

  const result = await guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" });

  expect(result.text).toBe("ok");
  expect(attempts).toBe(3);
});

test("timeout errors are not retried", async () => {
  let attempts = 0;

  const guarded = createVercelAIGuard(
    {
      generateText: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          text: "late",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
      streamText: () => ({
        text: Promise.resolve("ok"),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    {
      timeoutMs: 5,
      maxRetries: 5,
    },
  );

  await expect(guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" })).rejects.toBeInstanceOf(
    TimeoutError,
  );

  expect(attempts).toBe(1);
});

test("enforces budget using model from params", async () => {
  const pricing = createPricingResolver([
    {
      provider: "vercel-ai",
      model: "model-test",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    },
  ]);

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "expensive",
        usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
      }),
      streamText: () => ({
        text: Promise.resolve("ok"),
        usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    {
      pricing,
      maxCostUsd: 0.5,
    },
  );

  await expect(guarded.generateText({ model: "model-test", prompt: "hi" })).rejects.toBeInstanceOf(
    BudgetExceededError,
  );
});

test("streamText finalization runs once for text/usage/consumeStream", async () => {
  const logger = createMemoryLogger();
  let consumeCalls = 0;

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      streamText: () => ({
        text: Promise.resolve("stream text"),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
        totalUsage: Promise.resolve({ promptTokens: 12, completionTokens: 6, totalTokens: 18 }),
        consumeStream: async () => {
          consumeCalls += 1;
        },
      }),
    },
    {
      logger,
      name: "vercel-stream",
    },
  );

  const stream = guarded.streamText({ model: "gpt-4o-mini", prompt: "hi" });

  const text = await stream.text;
  expect(text).toBe("stream text");

  const usage = await stream.usage;
  expect(usage.totalTokens).toBe(15);

  await stream.consumeStream?.();
  await stream.totalUsage;

  expect(consumeCalls).toBe(1);

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.totalTokens).toBe(18);
  expect(logs[0]?.status).toBe("success");
});

test("streamText finalizes on async-iterator completion", async () => {
  const logger = createMemoryLogger();

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      streamText: () => ({
        textStream: (async function* () {
          yield "a";
          yield "b";
        })(),
        totalUsage: Promise.resolve({ promptTokens: 7, completionTokens: 3, totalTokens: 10 }),
      }),
    },
    {
      logger,
      name: "vercel-iterator",
    },
  );

  const stream = guarded.streamText({ model: "gpt-4o-mini", prompt: "hi" });

  const chunks: string[] = [];
  for await (const part of stream.textStream as AsyncIterable<string>) {
    chunks.push(part);
  }

  expect(chunks).toEqual(["a", "b"]);

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.totalTokens).toBe(10);
});

test("streamText enforces budget from totalUsage", async () => {
  const pricing = createPricingResolver([
    {
      provider: "vercel-ai",
      model: "stream-model",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    },
  ]);

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      streamText: () => ({
        totalUsage: Promise.resolve({
          promptTokens: 1_000_000,
          completionTokens: 0,
          totalTokens: 1_000_000,
        }),
      }),
    },
    {
      pricing,
      maxCostUsd: 0.5,
    },
  );

  const stream = guarded.streamText({ model: "stream-model", prompt: "hi" });
  await expect(stream.totalUsage).rejects.toBeInstanceOf(BudgetExceededError);
});

test("provider errors remain unwrapped", async () => {
  const providerError = new Error("provider failure");

  const guarded = createVercelAIGuard(
    {
      generateText: async () => {
        throw providerError;
      },
      streamText: () => ({
        totalUsage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
        text: Promise.reject(providerError),
      }),
    },
    { maxRetries: 0 },
  );

  await expect(guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" })).rejects.toBe(
    providerError,
  );

  const stream = guarded.streamText({ model: "gpt-4o-mini", prompt: "hi" });
  await expect(stream.text).rejects.toBe(providerError);
});

test("supports sqlite logger in adapter config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-vercel-ai-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });
    const pricing = createPricingResolver([
      {
        provider: "vercel-ai",
        model: "gpt-4o-mini",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 1,
      },
    ]);

    const guarded = createVercelAIGuard(
      {
        generateText: async () => ({
          text: "ok",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }),
        streamText: () => ({
          totalUsage: Promise.resolve({ promptTokens: 2, completionTokens: 1, totalTokens: 3 }),
          text: Promise.resolve("done"),
        }),
      },
      {
        logger,
        name: "vercel-sqlite-log",
        pricing,
      },
    );

    await guarded.generateText({ model: "gpt-4o-mini", prompt: "hi" });

    const report = readUsageReport({ dbPath });
    expect(report.totalRuns).toBe(1);
    expect(report.totalCalls).toBe(1);
    expect(report.mostExpensiveRun?.name).toBe("vercel-sqlite-log");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
