# @guard-sdk/core

Core runtime protection for AI and agent calls.

## API

- `guard.run(fn, config)`: wrap any async call with cost/token/call/timeout limits.
- `guard.createRun(config)`: create a multi-step run that shares a budget across calls.
- `createConsoleLogger()`: log guard usage summaries to stdout.
- `createMemoryLogger()`: retain usage records in memory for tests and inspection.
- `createJsonFileLogger(options)`: append NDJSON usage records to a file.
- `config.mode?: "enforce" | "dry-run"`: dry-run records what would block without enforcing budget/token/call-limit throws.
- `config.tokenizer?: (value: unknown) => number | Promise<number>`: custom fallback token estimation when provider usage is unavailable.

Dry-run metadata is returned in usage/log output:

- `wouldBlock?: boolean`
- `wouldBlockReasons?: Array<"CALL_LIMIT_EXCEEDED" | "TOKEN_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED">`

## Error classes

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

## Loggers

### Console Logger

```ts
import { createConsoleLogger, guard } from "@guard-sdk/core";

const logger = createConsoleLogger();

await guard.run(async () => "ok", {
  name: "example-run",
  logger,
});
// stdout: [guard] example-run | status: success | tokens: 12 | cost: $0.0001 | duration: 4ms
```

### Memory Logger

```ts
import { createMemoryLogger, guard } from "@guard-sdk/core";

const logger = createMemoryLogger();

await guard.run(async () => "ok", {
  name: "example-run",
  logger,
});

console.log(logger.records);
// [{ name: "example-run", status: "success", ... }]
```

### File Logger

```ts
import { createJsonFileLogger, guard } from "@guard-sdk/core";

const logger = createJsonFileLogger({
  filePath: "./.guard/usage.jsonl",
});

await guard.run(async () => "ok", {
  name: "example-run",
  logger,
});
```

`createJsonFileLogger` appends NDJSON records (one JSON usage object per line). Parent directories are created by default.

## Timeout behavior

Timeout is best-effort. When `timeoutMs` is exceeded, guard rejects with `TimeoutError`, but the underlying async work is not forcibly cancelled unless the wrapped function supports cancellation itself.
