# @guard-sdk/cli

CLI for reporting on guard-sdk usage data.

## Usage

```bash
guard report --db ./.guard/usage.db
```

## Report filters

```bash
guard report \
  --db ./.guard/usage.db \
  --from 2026-05-01T00:00:00.000Z \
  --to 2026-05-31T23:59:59.999Z \
  --name summarize-report \
  --status blocked
```
