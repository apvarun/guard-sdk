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
import { createAnthropicGuard } from "../src/index.ts";

test("returns raw messages.create response", async () => {
  const response = {
    id: "msg_1",
    usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
  };

  const client = {
    messages: {
      create: async () => response,
      stream: () => ({
        finalMessage: async () => response,
      }),
    },
  };

  const guarded = createAnthropicGuard(client);
  const result = await guarded.messages.create({
    model: "claude-opus-4-1-20250805",
    messages: [],
  });

  expect(result).toBe(response);
});

test("merges default config with per-call overrides", async () => {
  const logger = createMemoryLogger();

  const client = {
    messages: {
      create: async () => ({
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      }),
      stream: () => ({
        finalMessage: async () => ({
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      }),
    },
  };

  const guarded = createAnthropicGuard(client, {
    name: "default-name",
    maxCalls: 0,
    model: "default-model",
    logger,
  });

  await guarded.messages.create(
    {
      model: "claude-opus-4-1-20250805",
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
  expect(logs[0]?.provider).toBe("anthropic");
  expect(logs[0]?.model).toBe("claude-opus-4-1-20250805");
});

test("propagates call-limit guard errors unchanged", async () => {
  const client = {
    messages: {
      create: async () => ({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
      stream: () => ({
        finalMessage: async () => ({
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      }),
    },
  };

  const guarded = createAnthropicGuard(client, { maxCalls: 0 });

  await expect(
    guarded.messages.create({ model: "claude-opus-4-1-20250805", messages: [] }),
  ).rejects.toBeInstanceOf(CallLimitExceededError);
});

test("retries transient failures based on maxRetries", async () => {
  let attempts = 0;

  const client = {
    messages: {
      create: async () => {
        attempts += 1;

        if (attempts < 3) {
          throw new Error("temporary");
        }

        return { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      },
      stream: () => ({
        finalMessage: async () => ({
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      }),
    },
  };

  const guarded = createAnthropicGuard(client, { maxRetries: 2 });

  const result = await guarded.messages.create({
    model: "claude-opus-4-1-20250805",
    messages: [],
  });

  expect(result.usage?.total_tokens).toBe(15);
  expect(attempts).toBe(3);
});

test("enforces budget using model from params", async () => {
  const pricing = createPricingResolver([
    {
      provider: "anthropic",
      model: "claude-test",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    },
  ]);

  const client = {
    messages: {
      create: async () => ({
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          total_tokens: 1_000_000,
        },
      }),
      stream: () => ({
        finalMessage: async () => ({
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      }),
    },
  };

  const guarded = createAnthropicGuard(client, {
    pricing,
    maxCostUsd: 0.5,
  });

  await expect(
    guarded.messages.create({ model: "claude-test", messages: [] }),
  ).rejects.toBeInstanceOf(BudgetExceededError);
});

test("timeout errors are not retried", async () => {
  let attempts = 0;

  const client = {
    messages: {
      create: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } };
      },
      stream: () => ({
        finalMessage: async () => ({
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      }),
    },
  };

  const guarded = createAnthropicGuard(client, {
    timeoutMs: 5,
    maxRetries: 5,
  });

  await expect(
    guarded.messages.create({ model: "claude-opus-4-1-20250805", messages: [] }),
  ).rejects.toBeInstanceOf(TimeoutError);

  expect(attempts).toBe(1);
});

test("stream finalization logs once and preserves stream shape", async () => {
  const logger = createMemoryLogger();
  let finalMessageCalls = 0;

  const client = {
    messages: {
      create: async () => ({
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      stream: () => ({
        marker: "stream",
        finalMessage: async () => {
          finalMessageCalls += 1;
          return { usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 } };
        },
        untilDone: async () => {
          // no-op
        },
      }),
    },
  };

  const guarded = createAnthropicGuard(client, {
    name: "anthropic-stream",
    logger,
  });

  const stream = guarded.messages.stream({ model: "claude-opus-4-1-20250805", messages: [] });

  expect(stream.marker).toBe("stream");

  const final = await stream.finalMessage!();
  await stream.untilDone!();

  expect(final.usage?.total_tokens).toBe(60);
  expect(finalMessageCalls).toBe(1);

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.status).toBe("success");
  expect(logs[0]?.provider).toBe("anthropic");
});

test("stream untilDone-only path still finalizes once", async () => {
  const logger = createMemoryLogger();
  let untilDoneCalls = 0;

  const client = {
    messages: {
      create: async () => ({
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      stream: () => ({
        async untilDone() {
          untilDoneCalls += 1;
        },
      }),
    },
  };

  const guarded = createAnthropicGuard(client, {
    name: "anthropic-until-done",
    logger,
  });

  const stream = guarded.messages.stream({ model: "claude-opus-4-1-20250805", messages: [] });
  await stream.untilDone!();
  await stream.untilDone!();

  expect(untilDoneCalls).toBe(1);

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.status).toBe("success");
});

test("provider errors remain unwrapped", async () => {
  const providerError = new Error("provider failure");

  const client = {
    messages: {
      create: async () => {
        throw providerError;
      },
      stream: () => ({
        finalMessage: async () => {
          throw providerError;
        },
      }),
    },
  };

  const guarded = createAnthropicGuard(client, { maxRetries: 0 });

  await expect(
    guarded.messages.create({ model: "claude-opus-4-1-20250805", messages: [] }),
  ).rejects.toBe(providerError);

  const stream = guarded.messages.stream({ model: "claude-opus-4-1-20250805", messages: [] });
  await expect(stream.finalMessage!()).rejects.toBe(providerError);
});

test("supports sqlite logger in adapter config", async () => {
  const [dbPath, cleanup] = await createTempDbPath("guard-sdk-anthropic-");

  try {
    const pricing = createPricingResolver([
      {
        provider: "anthropic",
        model: "claude-opus-4-1-20250805",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 1,
      },
    ]);

    const client = {
      messages: {
        create: async () => ({
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        stream: () => ({
          finalMessage: async () => ({
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        }),
      },
    };

    const logger = await createSQLiteLogger({ dbPath });
    const guarded = createAnthropicGuard(client, {
      logger,
      name: "anthropic-sqlite-log",
      pricing,
    });

    await guarded.messages.create({ model: "claude-opus-4-1-20250805", messages: [] });

    const report = readUsageReport({ dbPath });
    expect(report.totalRuns).toBe(1);
    expect(report.totalCalls).toBe(1);
    expect(report.mostExpensiveRun?.name).toBe("anthropic-sqlite-log");
  } finally {
    await cleanup();
  }
});
