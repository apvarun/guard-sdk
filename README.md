# guard-sdk

Cost limits, timeouts, and circuit breakers for AI agents.

## Packages

- `@guard-sdk/core`: generic guard runtime (`guard.run`, `guard.createRun`)
- `@guard-sdk/pricing`: pricing resolver utilities
- `@guard-sdk/openai`: OpenAI chat completions adapter
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

## Examples

- `examples/basic`
- `examples/agent-loop`
- `examples/basic-openai`

## Development

```bash
vp check
vp test
vp run -r build
```
