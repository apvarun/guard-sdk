# @guard-sdk/otel

OpenTelemetry logger integration for guard-sdk.

## API

- `createOpenTelemetryLogger(config)`
- `toGuardTelemetryAttributes(usage)`
- `GUARD_TELEMETRY_SCHEMA_VERSION`
- `GUARD_TELEMETRY_ATTRIBUTE_KEYS`

`createOpenTelemetryLogger` returns a `GuardLogger` that emits one span and/or one log record per completed guard run.

## Config

```ts
import { createOpenTelemetryLogger } from "@guard-sdk/otel";

const logger = createOpenTelemetryLogger({
  tracer,
  logEmitter,
  spanName: "guard.run",
  logBody: "guard.run",
  traceSampleRate: 1,
  logSampleRate: 1,
});
```

- `tracer`: injected OpenTelemetry-compatible tracer.
- `logEmitter`: injected OpenTelemetry-compatible log emitter.
- At least one of `tracer` or `logEmitter` is required.
- Sampling values must be in `[0, 1]`.

## Guard Integration

```ts
import { guard } from "@guard-sdk/core";
import { createOpenTelemetryLogger } from "@guard-sdk/otel";

const logger = createOpenTelemetryLogger({
  tracer,
  logEmitter,
});

const { usage } = await guard.run(async () => callLLM(), {
  name: "report-summary",
  provider: "openai",
  model: "gpt-4.1-mini",
  logger,
});

console.log(usage);
```

### Agent loop (`guard.createRun`)

```ts
const run = guard.createRun({
  name: "research-agent",
  logger,
});

await run.call("step-1", async () => callLLM());
await run.call("step-2", async () => callLLM());

console.log(run.summary());
```

## Stable telemetry schema

Schema version: `1.0`.

Attributes use stable namespaced keys:

- `guard.schema_version`
- `guard.run_id`
- `guard.name`
- `guard.user_id`
- `guard.provider`
- `guard.model`
- `guard.status`
- `guard.blocked_reason`
- `guard.calls`
- `guard.retries`
- `guard.duration_ms`
- `guard.input_tokens`
- `guard.output_tokens`
- `guard.total_tokens`
- `guard.estimated_cost_usd`
- `guard.would_block`
- `guard.would_block_reasons`

Missing optional values are omitted.

## Semantic guarantees

- `v0.5` starts telemetry schema stability for these keys.
- Minor releases only add fields; existing keys keep meaning.
- `status` semantics stay aligned with `@guard-sdk/core`: `success | failed | blocked | timeout`.
