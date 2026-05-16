# Contributing

Thanks for contributing to `guard-sdk`.

## Prerequisites

- Bun `1.3.14` (see `packageManager` in root `package.json`)
- Node.js `>=22.12.0`

## Setup

```bash
vp install
```

## Validation

Run these before opening a pull request:

```bash
vp check
vp test
vp run -r build
```

## Pull Requests

- Keep changes focused and scoped.
- Add or update tests for behavior changes.
- Update docs when public behavior or usage changes.
- Ensure CI is green before requesting review.

## Commit and Branching

- Use descriptive commit messages.
- Prefer small, reviewable commits.
