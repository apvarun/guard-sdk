# guard-sdk

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/apvarun/guard-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/apvarun/guard-sdk/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-guard--sdk.js.org-blue)](https://guard-sdk.js.org)
[![npm](https://img.shields.io/npm/v/@guard-sdk/core)](https://www.npmjs.com/package/@guard-sdk/core)

Cost limits, timeouts, and circuit breakers for AI agents.

## Why guard-sdk?

AI agents can burn through budgets fast. A single runaway loop costs hundreds of dollars. guard-sdk puts guardrails around LLM calls:

- Set USD cost limits per operation
- Enforce token budgets with provider-aware counting
- Add call limits for rate control
- Timeout runaway operations
- Log usage for debugging and analytics

## Features

- Cost limits with USD budgeting
- Token limits with provider-aware counting
- Call limits for rate control
- Timeout enforcement
- Dry-run mode for testing
- Multiple logging backends (JSON, SQLite, OTEL)
- Provider adapters (OpenAI, Anthropic, Vercel AI)

## Packages

- `@guard-sdk/core`: generic guard runtime (`guard.run`, `guard.createRun`)
- `@guard-sdk/pricing`: pricing resolver utilities
- `@guard-sdk/openai`: OpenAI chat completions adapter
- `@guard-sdk/anthropic`: Anthropic messages adapter (create + stream finalization)
- `@guard-sdk/vercel-ai`: Vercel AI SDK adapter (`generateText`, `streamText`)
- `@guard-sdk/storage-sqlite`: SQLite logger + report query helpers
- `@guard-sdk/otel`: OpenTelemetry logger integration (spans + logs)
- `@guard-sdk/cli`: CLI reporting (`guard report`)

### Peer dependencies

These adapter packages require the corresponding peer dependency installed in your project:

| Package                | Peer dependency     | Version       |
| ---------------------- | ------------------- | ------------- |
| `@guard-sdk/openai`    | `openai`            | `>=6.0.0`     |
| `@guard-sdk/anthropic` | `@anthropic-ai/sdk` | `>=0.61.0 <1` |
| `@guard-sdk/vercel-ai` | `ai`                | `>=5.0.0`     |

## Install

Requires Node.js >= 22.12.0

```bash
bun add @guard-sdk/core
```

This project uses Vite+ for development. After cloning the repo, run:

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

### Other loggers

**Console logger** — writes usage summaries to stdout:

```ts
import { createConsoleLogger } from "@guard-sdk/core";

const logger = createConsoleLogger();
```

**Memory logger** — retains usage records in memory for inspection (useful in tests):

```ts
import { createMemoryLogger } from "@guard-sdk/core";

const logger = createMemoryLogger();

// after guard.run(..., { logger })
console.log(logger.records);
```

### Error classes

When a guard policy is violated, `guard.run` rejects with a typed error:

| Error                     | Thrown when                             |
| ------------------------- | --------------------------------------- |
| `BudgetExceededError`     | `estimatedCostUsd` exceeds `maxCostUsd` |
| `TokenLimitExceededError` | total tokens exceed `maxTokens`         |
| `CallLimitExceededError`  | call count exceeds `maxCalls`           |
| `TimeoutError`            | wall-clock time exceeds `timeoutMs`     |

All error classes extend `GuardError`.

```ts
import {
  guard,
  BudgetExceededError,
  TokenLimitExceededError,
  CallLimitExceededError,
  TimeoutError,
  GuardError,
} from "@guard-sdk/core";
```

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
guard report --db ./.guard/usage.db --json
guard report --db ./.guard/usage.db --status blocked
guard report --db ./.guard/usage.db --from 2026-05-01T00:00:00.000Z --to 2026-05-31T23:59:59.999Z
```

`--json` outputs the same report summary as a single JSON object for automation/pipelines.

**Programmatic usage** — read reports without the CLI:

```ts
import { readUsageReport } from "@guard-sdk/storage-sqlite";

const report = await readUsageReport({
  dbPath: "./.guard/usage.db",
  filters: { status: "blocked" },
});
console.log(report);
```

## OpenTelemetry Logger (v0.5)

```ts
import { guard } from "@guard-sdk/core";
import { createOpenTelemetryLogger } from "@guard-sdk/otel";

const logger = createOpenTelemetryLogger({
  tracer,
  logEmitter,
  traceSampleRate: 1,
  logSampleRate: 1,
});

await guard.run(async () => callLLM(), {
  name: "summary-job",
  provider: "openai",
  model: "gpt-4.1-mini",
  logger,
});

const run = guard.createRun({
  name: "agent-session",
  logger,
});

await run.call("step-1", async () => callLLM());
await run.call("step-2", async () => callLLM());
console.log(run.summary());
```

Telemetry fields are emitted with a stable, versioned schema (`guard.schema_version = "1.0"`).
Minor releases add fields without changing existing key meanings.

## Incident Query Cookbook

Vendor-neutral incident query examples and log/trace field mappings are documented in:

- [`docs/observability-cookbook.md`](./docs/observability-cookbook.md)

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

- `examples/basic` - Core guard.run usage with console logger
- `examples/agent-loop` - Multi-step agent session with guard.createRun
- `examples/basic-openai` - OpenAI adapter integration
- `examples/basic-anthropic` - Anthropic adapter integration
- `examples/basic-vercel-ai` - Vercel AI SDK adapter integration
- `examples/basic-otel` - OpenTelemetry logging setup

Run examples:

```bash
node examples/basic/index.js
```

## Community

- 🐛 [Report bugs](https://github.com/apvarun/guard-sdk/issues)
- 📖 [Documentation](https://guard-sdk.js.org)

## Development

```bash
vp check
vp test
vp run -r build
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation steps, and pull request guidelines.

This project is governed by a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

### Reporting vulnerabilities

Please report security issues privately via [GitHub Security Advisories](https://github.com/apvarun/guard-sdk/security/advisories/new). See [SECURITY.md](SECURITY.md) for details.
