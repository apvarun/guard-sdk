# GUARD-SDK Roadmap

## Current State

- v0.5 is complete.
- Core runtime, dry-run mode, pricing resolver, and logging are shipped.
- OpenAI, Anthropic, and Vercel AI adapters are shipped with parity tests.
- SQLite storage, CLI reporting, and OpenTelemetry integration are shipped.

## Release Plan

### v0.6: Hardening and Validation

- Expand cross-package integration tests.
- Harden configuration validation for runtime and loggers.
- Improve error messages with actionable context.
- Add SQLite performance baseline tests.

### v0.7: Extensibility

- Extract policy logic from `GuardRunController` into a composable policy layer.
- Improve logger interfaces for batching and error handling.
- Standardize adapter implementation patterns.
- Roll out TypeScript strictness package by package.

### v0.8+: Ecosystem Backlog

- Add adapters for Gemini, Cohere, Mistral, and Hugging Face.
- Add observability outputs (Prometheus exporter, Grafana templates, alerting starters).
- Add storage backends (PostgreSQL, MongoDB, Redis, object storage).
- Expand CLI workflows and analytics.
- Add enterprise features (multi-tenant support, RBAC, audit/SSO).

## Release Gates

- Ship unit tests with every feature.
- Add integration tests for cross-package behavior.
- Pass `vp check`, `vp run -r test`, and `vp run -r build`.
- Keep regression coverage for timeout behavior, blocked status propagation, logger final-emission behavior, and usage extraction compatibility.

## Product Boundaries

- Keep core runtime small and stable.
- Keep provider-specific logic in adapter packages.
- Keep token/cost values marked as estimates unless provider usage is available.
- Do not build a dashboard product before v1.
