# guard-sdk Observability Cookbook (Vendor-neutral)

This cookbook assumes guard telemetry attributes from `@guard-sdk/otel` schema `1.0`.

## Common incidents

### 1) Failed / timeout / blocked run volume

```sql
SELECT
  guard_status,
  COUNT(*) AS runs
FROM guard_events
WHERE ts >= :from_ts
  AND ts <= :to_ts
GROUP BY guard_status
ORDER BY runs DESC;
```

### 2) Blocked reason breakdown

```sql
SELECT
  guard_blocked_reason,
  COUNT(*) AS runs
FROM guard_events
WHERE guard_status = 'blocked'
  AND ts >= :from_ts
  AND ts <= :to_ts
GROUP BY guard_blocked_reason
ORDER BY runs DESC;
```

### 3) Cost spike detection by window

```sql
SELECT
  date_trunc('hour', ts) AS hour_bucket,
  SUM(guard_estimated_cost_usd) AS usd
FROM guard_events
WHERE guard_estimated_cost_usd IS NOT NULL
  AND ts >= :from_ts
  AND ts <= :to_ts
GROUP BY hour_bucket
ORDER BY hour_bucket;
```

### 4) Latency percentile trend

```sql
SELECT
  date_trunc('hour', ts) AS hour_bucket,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY guard_duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY guard_duration_ms) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY guard_duration_ms) AS p99_ms
FROM guard_events
WHERE ts >= :from_ts
  AND ts <= :to_ts
GROUP BY hour_bucket
ORDER BY hour_bucket;
```

## Log/trace correlation field mapping

| guard-sdk meaning   | OTel attribute key          | Notes                                           |
| ------------------- | --------------------------- | ----------------------------------------------- |
| Schema version      | `guard.schema_version`      | Current value: `1.0`                            |
| Run ID              | `guard.run_id`              | Primary correlation key across logs/spans       |
| Run name            | `guard.name`                | Optional                                        |
| User ID             | `guard.user_id`             | Optional                                        |
| Provider            | `guard.provider`            | Optional                                        |
| Model               | `guard.model`               | Optional                                        |
| Final status        | `guard.status`              | `success` \| `failed` \| `blocked` \| `timeout` |
| Blocked reason      | `guard.blocked_reason`      | Present for blocked/timeout paths               |
| Call count          | `guard.calls`               | Always present                                  |
| Retry count         | `guard.retries`             | Always present                                  |
| Duration            | `guard.duration_ms`         | Always present                                  |
| Input tokens        | `guard.input_tokens`        | Optional                                        |
| Output tokens       | `guard.output_tokens`       | Optional                                        |
| Total tokens        | `guard.total_tokens`        | Optional                                        |
| Estimated cost USD  | `guard.estimated_cost_usd`  | Optional                                        |
| Dry-run would block | `guard.would_block`         | Optional                                        |
| Dry-run reasons     | `guard.would_block_reasons` | Optional                                        |

## Notes

- Query names and table names are examples. Map these keys to your backend schema.
- Keep `guard.run_id` indexed for fast log/trace join workflows.
