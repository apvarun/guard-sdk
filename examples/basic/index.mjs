import { createJsonFileLogger, guard } from "@guard-sdk/core";

const logger = createJsonFileLogger({
  filePath: "./.guard/basic-usage.jsonl",
});

const result = await guard.run(
  async () => ({
    message: "hello from guard",
    usage: {
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
    },
  }),
  {
    name: "basic-example",
    provider: "openai",
    model: "gpt-4.1-mini",
    maxTokens: 500,
    maxCostUsd: 1,
    timeoutMs: 5_000,
    logger,
  },
);

console.log("Data:", result.data);
console.log("Usage:", result.usage);
