# @guard-sdk/core

Core runtime protection for AI and agent calls.

## API

- `guard.run(fn, config)`
- `guard.createRun(config)`
- `createConsoleLogger()`
- `createMemoryLogger()`
- `createJsonFileLogger(options)`
- `config.mode?: "enforce" | "dry-run"`: dry-run records what would block without enforcing budget/token/call-limit throws.
- `config.tokenizer?: (value: unknown) => number | Promise<number>`: custom fallback token estimation when provider usage is unavailable.

Dry-run metadata is returned in usage/log output:

- `wouldBlock?: boolean`
- `wouldBlockReasons?: Array<"CALL_LIMIT_EXCEEDED" | "TOKEN_LIMIT_EXCEEDED" | "BUDGET_EXCEEDED">`

## File Logger

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
