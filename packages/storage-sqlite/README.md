# @guard-sdk/storage-sqlite

SQLite persistence and report queries for guard-sdk usage logs.

## API

- `createSQLiteLogger(options)`
- `readUsageReport(options)`

## Usage

```ts
import { guard } from "@guard-sdk/core";
import { createSQLiteLogger } from "@guard-sdk/storage-sqlite";

const logger = await createSQLiteLogger({
  dbPath: "./.guard/usage.db",
});

await guard.run(async () => "ok", {
  name: "sqlite-example",
  logger,
});
```

## CLI Integration

`@guard-sdk/cli` can read the same database:

```bash
guard report --db ./.guard/usage.db
```
