# guard-sdk

Cost limits, timeouts, and circuit breakers for AI agents.

## Packages

- `@guard-sdk/core`: generic guard runtime (`guard.run`, `guard.createRun`)
- `@guard-sdk/pricing`: pricing resolver utilities
- `@guard-sdk/openai`: OpenAI chat completions adapter
- `@guard-sdk/anthropic`: Anthropic messages adapter (create + stream finalization)
- `@guard-sdk/vercel-ai`: Vercel AI SDK adapter (`generateText`, `streamText`)
- `@guard-sdk/storage-sqlite`: SQLite logger + report query helpers
- `@guard-sdk/cli`: CLI reporting (`guard report`)

## Install

```bash
vp install
```

## Quickstart (Core)

```ts
import { createJsonFileLogger, guard } from "@guard-sdk/core";

const { data, usage } = await guard.run(
  async () => {
    return await callLLM();
  },
  {
    name: "summarize-report",
    maxCostUsd: 1,
    maxTokens: 5000,
    maxCalls: 3,
    maxRetries: 2,
    timeoutMs: 30000,
    logger: createJsonFileLogger({
      filePath: "./.guard/usage.jsonl",
    }),
  },
);

console.log(data);
console.log(usage);
```

`createJsonFileLogger` writes newline-delimited JSON (NDJSON), one usage record per line.

## Dry-run mode

Use `mode: "dry-run"` to simulate policy blocking without throwing budget/token/call-limit errors.

```ts
import { guard } from "@guard-sdk/core";

const result = await guard.run(async () => callLLM(), {
  mode: "dry-run",
  maxTokens: 5000,
  maxCostUsd: 1,
});

console.log(result.usage.status); // "success" when call succeeds
console.log(result.usage.wouldBlock); // true when any policy would block
console.log(result.usage.wouldBlockReasons); // e.g. ["TOKEN_LIMIT_EXCEEDED"]
```

Dry-run does not suppress timeout or runtime failures. Those still reject with the original error path.

## Token and cost semantics

- If provider usage exists (for example `usage.prompt_tokens`), guard uses provider-reported values.
- If provider usage is absent, guard estimates tokens.
- Cost is always estimated from pricing data and token counts.
- `estimatedCostUsd` can be `undefined` when provider/model pricing is unavailable.

### Custom tokenizer

When provider usage is missing, you can provide a tokenizer:

```ts
import { guard } from "@guard-sdk/core";

await guard.run(async () => ({ output: "hello world" }), {
  tokenizer: async (value) => {
    const text = JSON.stringify(value) ?? "";
    return Math.ceil(text.length / 3);
  },
});
```

If the tokenizer throws or returns an invalid value, guard falls back to the built-in heuristic.

## Pricing override patterns

```ts
import { createPricingResolver, createPricingResolverWithDefaults } from "@guard-sdk/pricing";
```

Full custom pricing table (no bundled fallback):

```ts
const pricing = createPricingResolver([
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 0.4,
    outputPerMillionTokens: 1.6,
  },
]);
```

Override selected models while keeping bundled defaults for the rest:

```ts
const pricing = createPricingResolverWithDefaults([
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 0.35,
    outputPerMillionTokens: 1.4,
  },
]);
```

Troubleshooting:

- `estimatedCostUsd` is missing: ensure `provider`, `model`, and matching pricing entry are set.
- Cost looks inaccurate: provider usage and tokenizer-based values are estimates; override pricing to match your billing source of truth.

## SQLite Logger + CLI Report (v0.2)

```ts
import { guard } from "@guard-sdk/core";
import { createSQLiteLogger } from "@guard-sdk/storage-sqlite";

const logger = await createSQLiteLogger({
  dbPath: "./.guard/usage.db",
});

await guard.run(async () => callLLM(), {
  name: "daily-summary",
  logger,
});
```

```bash
guard report --db ./.guard/usage.db
guard report --db ./.guard/usage.db --status blocked
guard report --db ./.guard/usage.db --from 2026-05-01T00:00:00.000Z --to 2026-05-31T23:59:59.999Z
```

### Timeout semantics (MVP)

Timeouts are best-effort. `guard.run` rejects with `TimeoutError` once `timeoutMs` is exceeded, but it cannot forcibly cancel work that does not support cancellation.

Use a cancellable function when your provider supports `AbortSignal`:

```ts
import { guard } from "@guard-sdk/core";

await guard.run(
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      return await client.chat.completions.create(
        { model: "gpt-4.1-mini", messages },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  },
  { timeoutMs: 31_000 },
);
```

## Quickstart (OpenAI Adapter)

```ts
import OpenAI from "openai";
import { createOpenAIGuard } from "@guard-sdk/openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const guardedOpenAI = createOpenAIGuard(openai, {
  name: "chat-completion",
  maxCostUsd: 1,
  maxTokens: 5000,
  timeoutMs: 30000,
});

const response = await guardedOpenAI.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [{ role: "user", content: "Summarize this report." }],
});

console.log(response.usage);
```

## Quickstart (Anthropic Adapter)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicGuard } from "@guard-sdk/anthropic";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const guardedAnthropic = createAnthropicGuard(anthropic, {
  name: "anthropic-message",
  maxCostUsd: 1,
  maxTokens: 5000,
  timeoutMs: 30000,
});

const response = await guardedAnthropic.messages.create({
  model: "claude-opus-4-1-20250805",
  messages: [{ role: "user", content: "Summarize this report." }],
});

console.log(response.usage);
```

## Quickstart (Vercel AI SDK Adapter)

```ts
import { generateText, streamText } from "ai";
import { createVercelAIGuard } from "@guard-sdk/vercel-ai";

const guardedAI = createVercelAIGuard(
  { generateText, streamText },
  {
    name: "vercel-ai-text",
    model: "gpt-4o-mini",
    maxCostUsd: 1,
    maxTokens: 5000,
    timeoutMs: 30000,
  },
);

const generated = await guardedAI.generateText({
  model: "gpt-4o-mini",
  prompt: "Summarize this report.",
});

console.log(generated.usage);

const streamed = guardedAI.streamText({
  model: "gpt-4o-mini",
  prompt: "Stream a short summary.",
});

for await (const chunk of streamed.textStream) {
  process.stdout.write(chunk);
}
```

## Examples

- `examples/basic`
- `examples/agent-loop`
- `examples/basic-openai`
- `examples/basic-anthropic`
- `examples/basic-vercel-ai`

## Development

```bash
vp check
vp test
vp run -r build
```
