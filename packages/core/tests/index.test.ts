import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { createPricingResolver } from "@guard-sdk/pricing";
import {
  BudgetExceededError,
  CallLimitExceededError,
  GuardError,
  TimeoutError,
  TokenLimitExceededError,
  createJsonFileLogger,
  createMemoryLogger,
  guard,
} from "../src/index.ts";

test("guard.run returns data and usage", async () => {
  const { data, usage } = await guard.run(async () => "ok");

  expect(data).toBe("ok");
  expect(usage.calls).toBe(1);
  expect(usage.status).toBe("success");
  expect(usage.totalTokens).toBeGreaterThan(0);
});

test("guard.run retries and succeeds", async () => {
  let attempts = 0;

  const { data, usage } = await guard.run(
    async () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error("retry me");
      }

      return "done";
    },
    { maxRetries: 2 },
  );

  expect(data).toBe("done");
  expect(attempts).toBe(3);
  expect(usage.retries).toBe(2);
});

test("guard.run fails after maxRetries", async () => {
  let attempts = 0;

  await expect(
    guard.run(
      async () => {
        attempts += 1;
        throw new Error("still failing");
      },
      { maxRetries: 2 },
    ),
  ).rejects.toThrow("still failing");

  expect(attempts).toBe(3);
});

test("timeout throws TimeoutError and does not retry", async () => {
  let attempts = 0;

  await expect(
    guard.run(
      async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "late";
      },
      { timeoutMs: 5, maxRetries: 3 },
    ),
  ).rejects.toBeInstanceOf(TimeoutError);

  expect(attempts).toBe(1);
});

test("createRun blocks call when maxCalls exceeded", async () => {
  const run = guard.createRun({ maxCalls: 1 });

  await expect(run.call("first", async () => "ok")).resolves.toBe("ok");
  await expect(run.call("second", async () => "nope")).rejects.toBeInstanceOf(
    CallLimitExceededError,
  );
});

test("token limit is enforced", async () => {
  await expect(
    guard.run(async () => ({ usage: { total_tokens: 11 } }), {
      maxTokens: 10,
    }),
  ).rejects.toBeInstanceOf(TokenLimitExceededError);
});

test("budget limit is enforced", async () => {
  const pricing = createPricingResolver([
    {
      provider: "openai",
      model: "gpt-test",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    },
  ]);

  await expect(
    guard.run(
      async () => ({
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      }),
      {
        provider: "openai",
        model: "gpt-test",
        maxCostUsd: 0.5,
        pricing,
      },
    ),
  ).rejects.toBeInstanceOf(BudgetExceededError);
});

test("custom tokenizer is used when provider usage is missing", async () => {
  const { usage } = await guard.run(async () => ({ message: "hello" }), {
    tokenizer: async () => 42,
  });

  expect(usage.totalTokens).toBe(42);
});

test("provider usage takes precedence over custom tokenizer", async () => {
  const { usage } = await guard.run(
    async () => ({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    {
      tokenizer: () => 9999,
    },
  );

  expect(usage.inputTokens).toBe(10);
  expect(usage.outputTokens).toBe(5);
  expect(usage.totalTokens).toBe(15);
});

test("tokenizer fallback uses heuristic when tokenizer returns invalid values", async () => {
  const data = { payload: "abcdef" };
  const expectedTotalTokens = Math.ceil((JSON.stringify(data) ?? "").length / 4);

  const invalidValue = await guard.run(async () => data, {
    tokenizer: () => Number.NaN,
  });
  expect(invalidValue.usage.totalTokens).toBe(expectedTotalTokens);

  const negativeValue = await guard.run(async () => data, {
    tokenizer: () => -1,
  });
  expect(negativeValue.usage.totalTokens).toBe(expectedTotalTokens);

  const throwingTokenizer = await guard.run(async () => data, {
    tokenizer: () => {
      throw new Error("tokenizer failed");
    },
  });
  expect(throwingTokenizer.usage.totalTokens).toBe(expectedTotalTokens);
});

test("dry-run mode reports pre-call violations without blocking", async () => {
  const run = guard.createRun({
    mode: "dry-run",
    maxCalls: 0,
  });

  await expect(run.call("first", async () => "ok")).resolves.toBe("ok");

  const summary = run.summary();
  expect(summary.status).toBe("success");
  expect(summary.wouldBlock).toBe(true);
  expect(summary.wouldBlockReasons).toContain("CALL_LIMIT_EXCEEDED");
});

test("dry-run mode reports post-call token and budget violations without blocking", async () => {
  const pricing = createPricingResolver([
    {
      provider: "openai",
      model: "gpt-test",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
    },
  ]);

  const { data, usage } = await guard.run(
    async () => ({
      ok: true,
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    }),
    {
      mode: "dry-run",
      provider: "openai",
      model: "gpt-test",
      maxTokens: 10,
      maxCostUsd: 0.5,
      pricing,
    },
  );

  expect(data.ok).toBe(true);
  expect(usage.status).toBe("success");
  expect(usage.wouldBlock).toBe(true);
  expect(usage.wouldBlockReasons).toEqual(
    expect.arrayContaining(["TOKEN_LIMIT_EXCEEDED", "BUDGET_EXCEEDED"]),
  );
});

test("dry-run mode still enforces timeout failures", async () => {
  await expect(
    guard.run(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "late";
      },
      {
        mode: "dry-run",
        timeoutMs: 5,
      },
    ),
  ).rejects.toBeInstanceOf(TimeoutError);
});

test("dry-run metadata is included in logger output", async () => {
  const logger = createMemoryLogger();

  const run = guard.createRun({
    mode: "dry-run",
    maxCalls: 0,
    logger,
  });

  await run.call("dry", async () => "ok");
  run.summary();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.status).toBe("success");
  expect(logs[0]?.wouldBlock).toBe(true);
  expect(logs[0]?.wouldBlockReasons).toContain("CALL_LIMIT_EXCEEDED");
});

test("logger is called once with final usage", async () => {
  const logger = createMemoryLogger();

  await guard.run(async () => "ok", { logger });

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.status).toBe("success");
});

test("run summary logs once even when called multiple times", async () => {
  const logger = createMemoryLogger();
  const run = guard.createRun({ logger });

  await run.call("first", async () => "ok");
  run.summary();
  run.summary();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const logs = logger.getLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0]?.status).toBe("success");
});

test("json file logger writes NDJSON per run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-core-"));
  const filePath = join(directory, "usage.jsonl");

  try {
    const logger = createJsonFileLogger({ filePath });

    await guard.run(async () => ({ usage: { total_tokens: 2 } }), { logger, name: "first" });
    await guard.run(async () => ({ usage: { total_tokens: 3 } }), { logger, name: "second" });

    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? "{}") as { name?: string; status?: string };
    const second = JSON.parse(lines[1] ?? "{}") as { name?: string; status?: string };

    expect(first.name).toBe("first");
    expect(first.status).toBe("success");
    expect(second.name).toBe("second");
    expect(second.status).toBe("success");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("json file logger creates parent directory by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-core-"));
  const filePath = join(directory, "nested", "logs", "usage.jsonl");

  try {
    const logger = createJsonFileLogger({ filePath });
    await guard.run(async () => "ok", { logger });

    const content = await readFile(filePath, "utf8");
    expect(content.length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("json file logger propagates append errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-core-"));
  const filePath = join(directory, "missing", "usage.jsonl");

  try {
    const logger = createJsonFileLogger({ filePath, mkdir: false });

    await expect(guard.run(async () => "ok", { logger })).rejects.toThrow(/ENOENT|no such file/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("json file logger captures success, blocked, failed, and timeout statuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-core-"));
  const filePath = join(directory, "usage.jsonl");
  const logger = createJsonFileLogger({ filePath });

  try {
    await guard.run(async () => "ok", { logger, name: "success" });
    await expect(
      guard.run(async () => "never", { logger, name: "blocked", maxCalls: 0 }),
    ).rejects.toBeInstanceOf(CallLimitExceededError);
    await expect(
      guard.run(
        async () => {
          throw new Error("boom");
        },
        { logger, name: "failed", maxRetries: 0 },
      ),
    ).rejects.toThrow("boom");
    await expect(
      guard.run(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "late";
        },
        { logger, name: "timeout", timeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);

    const lines = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status?: string });

    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.status)).toEqual(["success", "blocked", "failed", "timeout"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guard errors carry code and usage", async () => {
  await expect(guard.run(async () => "never", { maxCalls: 0 })).rejects.toMatchObject({
    code: "CALL_LIMIT_EXCEEDED",
  });
  await expect(guard.run(async () => "never", { maxCalls: 0 })).rejects.toBeInstanceOf(GuardError);
});
