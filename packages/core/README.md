# @guard-sdk/core

Core runtime protection for AI and agent calls.

## API

- `guard.run(fn, config)`
- `guard.createRun(config)`
- `createConsoleLogger()`
- `createMemoryLogger()`
- `createJsonFileLogger(options)`

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
