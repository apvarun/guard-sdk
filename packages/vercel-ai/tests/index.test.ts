import { expect, test } from "vite-plus/test";
import {
  BudgetExceededError,
  CallLimitExceededError,
  TimeoutError,
  createMemoryLogger,
  createTempDbPath,
} from "@guard-sdk/core";
import { createPricingResolver } from "@guard-sdk/pricing";
import { createSQLiteLogger, readUsageReport } from "../../storage-sqlite/src/index.ts";
import { createVercelAIGuard } from "../src/index.ts";

function withAbortSignalAnyUnavailable<T>(fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    value: undefined,
  });

  return fn().finally(() => {
    if (descriptor) {
      Object.defineProperty(AbortSignal, "any", descriptor);
      return;
    }

    Reflect.deleteProperty(AbortSignal, "any");
  });
}

function trackAbortListeners(signal: AbortSignal) {
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;

  signal.addEventListener = ((
    type: Parameters<AbortSignal["addEventListener"]>[0],
    listener: Parameters<AbortSignal["addEventListener"]>[1],
    options: Parameters<AbortSignal["addEventListener"]>[2],
  ) => {
    if (type === "abort") {
      added += 1;
    }

    return originalAdd(type, listener, options);
  }) as AbortSignal["addEventListener"];

  signal.removeEventListener = ((
    type: Parameters<AbortSignal["removeEventListener"]>[0],
    listener: Parameters<AbortSignal["removeEventListener"]>[1],
    options: Parameters<AbortSignal["removeEventListener"]>[2],
  ) => {
    if (type === "abort") {
      removed += 1;
    }

    return originalRemove(type, listener, options);
  }) as AbortSignal["removeEventListener"];

  return {
    get added() {
      return added;
    },
    get removed() {
      return removed;
    },
  };
}

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

test("generateText fallback abort listeners are removed after success", async () => {
  await withAbortSignalAnyUnavailable(async () => {
    const caller = new AbortController();
    const listeners = trackAbortListeners(caller.signal);

    const guarded = createVercelAIGuard(
      {
        generateText: async () => ({
          text: "hello",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }),
        streamText: () => ({
          text: Promise.resolve("hello"),
          usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
        }),
      },
      { timeoutMs: 100 },
    );

    await guarded.generateText({
      model: "gpt-4o-mini",
      prompt: "hi",
      abortSignal: caller.signal,
    });

    expect(listeners.added).toBe(1);
    expect(listeners.removed).toBe(1);
  });
});

test("generateText fallback abort listeners are removed after provider failure", async () => {
  await withAbortSignalAnyUnavailable(async () => {
    const caller = new AbortController();
    const listeners = trackAbortListeners(caller.signal);
    const providerError = new Error("provider failed");

    const guarded = createVercelAIGuard(
      {
        generateText: async () => {
          throw providerError;
        },
        streamText: () => ({
          text: Promise.resolve("hello"),
          usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
        }),
      },
      { timeoutMs: 100 },
    );

    await expect(
      guarded.generateText({
        model: "gpt-4o-mini",
        prompt: "hi",
        abortSignal: caller.signal,
      }),
    ).rejects.toBe(providerError);

    expect(listeners.added).toBe(1);
    expect(listeners.removed).toBe(1);
  });
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

test("streamText fallback abort listeners are removed after finalization", async () => {
  await withAbortSignalAnyUnavailable(async () => {
    const caller = new AbortController();
    const listeners = trackAbortListeners(caller.signal);

    const guarded = createVercelAIGuard(
      {
        generateText: async () => ({
          text: "ok",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }),
        streamText: () => ({
          text: Promise.resolve("stream"),
          usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
        }),
      },
      { timeoutMs: 100 },
    );

    const result = guarded.streamText({
      model: "gpt-4o-mini",
      prompt: "hi",
      abortSignal: caller.signal,
    });

    await result.text;

    expect(listeners.added).toBe(1);
    expect(listeners.removed).toBe(1);
  });
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

test("streamText finalizes when async-iterator next throws", async () => {
  const logger = createMemoryLogger();
  const providerError = new Error("stream blew up");

  const guarded = createVercelAIGuard(
    {
      generateText: async () => ({
        text: "ok",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      streamText: () => ({
        textStream: {
          [Symbol.asyncIterator]() {
            let count = 0;
            return {
              next: async () => {
                if (count === 0) {
                  count += 1;
                  return { done: false, value: "a" };
                }

                throw providerError;
              },
            };
          },
        },
        totalUsage: Promise.resolve({ promptTokens: 9, completionTokens: 3, totalTokens: 12 }),
      }),
    },
    {
      logger,
      name: "vercel-iterator-throw",
    },
  );

  const stream = guarded.streamText({ model: "gpt-4o-mini", prompt: "hi" });

  await expect(
    (async () => {
      for await (const _ of stream.textStream as AsyncIterable<string>) {
        // iterate until failure
      }
    })(),
  ).rejects.toBe(providerError);

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.totalTokens).toBe(12);
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

test("stream wrapper preserves symbol-keyed properties", async () => {
  const marker = Symbol("marker");

  const guarded = createVercelAIGuard({
    generateText: async () => ({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
    streamText: () => {
      const stream = {
        totalUsage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
        text: Promise.resolve("ok"),
      } as {
        text: Promise<string>;
        totalUsage: Promise<{
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        }>;
        [key: symbol]: string;
      };

      stream[marker] = "symbol-value";
      return stream;
    },
  });

  const stream = guarded.streamText({ model: "gpt-4o-mini", prompt: "hi" }) as {
    [key: symbol]: string;
  };

  expect(stream[marker]).toBe("symbol-value");
});

test("supports sqlite logger in adapter config", async () => {
  const [dbPath, cleanup] = await createTempDbPath("guard-sdk-vercel-ai-");

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
    await cleanup();
  }
});

test("generateText preserves a caller-supplied abortSignal", async () => {
  const userController = new AbortController();
  let received: { abortSignal?: AbortSignal } | undefined;

  const guarded = createVercelAIGuard({
    generateText: async (params: { abortSignal?: AbortSignal }) => {
      received = params;
      return { usage: { totalTokens: 1 } };
    },
    streamText: () => ({}) as never,
  });

  await guarded.generateText({ model: "gpt-4o-mini", abortSignal: userController.signal } as never);

  // The signal handed to the SDK merges the guard signal with the caller's,
  // so aborting the caller's controller still cancels the underlying call.
  expect(received?.abortSignal).toBeInstanceOf(AbortSignal);
  expect(received?.abortSignal?.aborted).toBe(false);
  userController.abort();
  expect(received?.abortSignal?.aborted).toBe(true);
});
