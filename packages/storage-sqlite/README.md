# @guard-sdk/storage-sqlite

SQLite persistence and report queries for guard-sdk usage logs.

## API

- `createSQLiteLogger(options)`: returns a `GuardLogger` that writes usage records to a SQLite database.
- `readUsageReport(options)`: query usage records from a SQLite database programmatically (no CLI needed).

## Usage

### Logger

```ts
import { guard } from "@guard-sdk/core";
import { createSQLiteLogger } from "@guard-sdk/storage-sqlite";

const logger = await createSQLiteLogger({
  dbPath: "./.guard/usage.db",
  maxPendingWrites: 1000,
});

await guard.run(async () => "ok", {
  name: "sqlite-example",
  logger,
});

// Optional: close when the process is done writing logs.
logger.close();
```

### Programmatic report query

```ts
import { readUsageReport } from "@guard-sdk/storage-sqlite";

const report = await readUsageReport({
  dbPath: "./.guard/usage.db",
  filters: {
    status: "blocked",
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-05-31T23:59:59.999Z",
  },
});

console.log(report);
// { totalCalls: 3, totalCostUsd: 0, blocked: 3, ... }
```

## CLI Integration

`@guard-sdk/cli` can read the same database:

```bash
guard report --db ./.guard/usage.db
guard report --db ./.guard/usage.db --json
guard report --db ./.guard/usage.db --status blocked
guard report --db ./.guard/usage.db --from 2026-05-01T00:00:00.000Z --to 2026-05-31T23:59:59.999Z
```
