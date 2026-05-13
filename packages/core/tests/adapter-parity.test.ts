import { expect, test } from "vite-plus/test";
import { CallLimitExceededError, TimeoutError, createMemoryLogger } from "@guard-sdk/core";
import { createOpenAIGuard } from "../../openai/src/index.ts";
import { createAnthropicGuard } from "../../anthropic/src/index.ts";
import { createVercelAIGuard } from "../../vercel-ai/src/index.ts";

test("blocked status parity across adapters", async () => {
  const openaiLogger = createMemoryLogger();
  const anthropicLogger = createMemoryLogger();
  const vercelLogger = createMemoryLogger();

  const openai = createOpenAIGuard(
    {
      chat: {
        completions: {
          create: async () => ({
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    },
    { logger: openaiLogger, maxCalls: 0 },
  );

  const anthropic = createAnthropicGuard(
    {
      messages: {
        create: async () => ({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
        stream: () => ({
          finalMessage: async () => ({
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        }),
      },
    },
    { logger: anthropicLogger, maxCalls: 0 },
  );

  const vercel = createVercelAIGuard(
    {
      generateText: async () => ({
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
      streamText: () => ({
        totalUsage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    { logger: vercelLogger, maxCalls: 0 },
  );

  await expect(
    openai.chat.completions.create({ model: "gpt-4o-mini", messages: [] }),
  ).rejects.toBeInstanceOf(CallLimitExceededError);
  await expect(
    anthropic.messages.create({ model: "claude-opus-4-1-20250805", messages: [] }),
  ).rejects.toBeInstanceOf(CallLimitExceededError);
  await expect(vercel.generateText({ model: "gpt-4o-mini", prompt: "hi" })).rejects.toBeInstanceOf(
    CallLimitExceededError,
  );

  expect(openaiLogger.getLogs()[0]?.status).toBe("blocked");
  expect(anthropicLogger.getLogs()[0]?.status).toBe("blocked");
  expect(vercelLogger.getLogs()[0]?.status).toBe("blocked");
});

test("timeout status parity across adapters", async () => {
  const openaiLogger = createMemoryLogger();
  const anthropicLogger = createMemoryLogger();
  const vercelLogger = createMemoryLogger();

  let openaiAttempts = 0;
  let anthropicAttempts = 0;
  let vercelAttempts = 0;

  const openai = createOpenAIGuard(
    {
      chat: {
        completions: {
          create: async () => {
            openaiAttempts += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
          },
        },
      },
    },
    { logger: openaiLogger, timeoutMs: 5, maxRetries: 4 },
  );

  const anthropic = createAnthropicGuard(
    {
      messages: {
        create: async () => {
          anthropicAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        },
        stream: () => ({
          finalMessage: async () => ({
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        }),
      },
    },
    { logger: anthropicLogger, timeoutMs: 5, maxRetries: 4 },
  );

  const vercel = createVercelAIGuard(
    {
      generateText: async () => {
        vercelAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      streamText: () => ({
        totalUsage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    { logger: vercelLogger, timeoutMs: 5, maxRetries: 4 },
  );

  await expect(
    openai.chat.completions.create({ model: "gpt-4o-mini", messages: [] }),
  ).rejects.toBeInstanceOf(TimeoutError);
  await expect(
    anthropic.messages.create({ model: "claude-opus-4-1-20250805", messages: [] }),
  ).rejects.toBeInstanceOf(TimeoutError);
  await expect(vercel.generateText({ model: "gpt-4o-mini", prompt: "hi" })).rejects.toBeInstanceOf(
    TimeoutError,
  );

  expect(openaiAttempts).toBe(1);
  expect(anthropicAttempts).toBe(1);
  expect(vercelAttempts).toBe(1);

  expect(openaiLogger.getLogs()[0]?.status).toBe("timeout");
  expect(anthropicLogger.getLogs()[0]?.status).toBe("timeout");
  expect(vercelLogger.getLogs()[0]?.status).toBe("timeout");
});

test("failure status parity across adapters", async () => {
  const openaiLogger = createMemoryLogger();
  const anthropicLogger = createMemoryLogger();
  const vercelLogger = createMemoryLogger();

  const openai = createOpenAIGuard(
    {
      chat: {
        completions: {
          create: async () => {
            throw new Error("openai fail");
          },
        },
      },
    },
    { logger: openaiLogger, maxRetries: 0 },
  );

  const anthropic = createAnthropicGuard(
    {
      messages: {
        create: async () => {
          throw new Error("anthropic fail");
        },
        stream: () => ({
          finalMessage: async () => ({
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        }),
      },
    },
    { logger: anthropicLogger, maxRetries: 0 },
  );

  const vercel = createVercelAIGuard(
    {
      generateText: async () => {
        throw new Error("vercel fail");
      },
      streamText: () => ({
        totalUsage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      }),
    },
    { logger: vercelLogger, maxRetries: 0 },
  );

  await expect(
    openai.chat.completions.create({ model: "gpt-4o-mini", messages: [] }),
  ).rejects.toThrow("openai fail");
  await expect(
    anthropic.messages.create({ model: "claude-opus-4-1-20250805", messages: [] }),
  ).rejects.toThrow("anthropic fail");
  await expect(vercel.generateText({ model: "gpt-4o-mini", prompt: "hi" })).rejects.toThrow(
    "vercel fail",
  );

  expect(openaiLogger.getLogs()[0]?.status).toBe("failed");
  expect(anthropicLogger.getLogs()[0]?.status).toBe("failed");
  expect(vercelLogger.getLogs()[0]?.status).toBe("failed");
});
