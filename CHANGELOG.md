# Changelog

## 0.6.0 (2026-06-15)

- Per-user cumulative budgets: new `@guard-sdk/budget` package (`createMemoryBudgetStore`) and `createSQLiteBudgetStore` in `@guard-sdk/storage-sqlite`, wired into the core via `budget`, `budgetKey`, `budgetWindow`, `maxUserCostUsd`, `maxUserTokens`, and `maxUserCalls`. Stores enforce atomically via `commit` (race-safe across concurrent runs: `maxUserCalls` is reserved pre-call, while `maxUserCostUsd`/`maxUserTokens` may overshoot by at most one in-flight call), and a store error fails the run closed rather than silently proceeding
- Lifecycle hooks on `GuardConfig.hooks`: `onStart`, `onCall`, `onRetry`, `onBlock`, `onFinish`, `onWarn` (a throwing hook never breaks the guarded call)
- True cancellation: timeouts and a caller-supplied `signal` now abort in-flight provider requests via an `AbortSignal` threaded into the OpenAI, Anthropic, and Vercel AI adapters
- Config validation: `validateGuardConfig` / `GuardConfigError` reject invalid configs early with actionable, field-named messages; blocked-run errors now include the limit and actual value
- Soft warnings: `warnAtCostUsd` / `warnAtTokens` emit non-blocking `usage.warnings` and fire `onWarn`
- OpenAI streaming parity (`stream: true`) with lazy usage finalization
- Expanded default pricing catalog (current OpenAI, Anthropic, and Google Gemini models)
- Expanded cross-package integration tests and a SQLite write-queue baseline

## 0.5.0 (2026-05-14)

- OpenTelemetry logger integration (`@guard-sdk/otel`)
- spans + logs with versioned schema

## 0.4.0

- Improved pricing calculation accuracy
- Dry-run mode (`mode: "dry-run"`)
- Documentation website

## 0.3.0

- Anthropic messages adapter (`@guard-sdk/anthropic`)
- Vercel AI SDK adapter (`@guard-sdk/vercel-ai`)

## 0.2.0

- SQLite logger (`@guard-sdk/storage-sqlite`)
- CLI reporting (`@guard-sdk/cli` / `guard report`)

## 0.1.0

- Core guard runtime (`@guard-sdk/core`)
- Pricing resolver (`@guard-sdk/pricing`)
- OpenAI chat completions adapter (`@guard-sdk/openai`)
- `guard.run`, `guard.createRun`
- Cost limits, token limits, call limits, timeouts, retries
- JSON file logger
- Custom tokenizer support
- Pricing overrides
