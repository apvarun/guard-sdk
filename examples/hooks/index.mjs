import { guard } from "@guard-sdk/core";

// Lifecycle hooks observe a run without changing its behaviour. A hook that
// throws is caught and never breaks the guarded call, so they are safe for
// alerting and metrics. Soft warnings (`warnAtCostUsd` / `warnAtTokens`) fire
// `onWarn` and populate `usage.warnings` without blocking.
const result = await guard.run(
  async () => ({
    message: "hello from guard",
    usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 },
  }),
  {
    name: "hooks-example",
    provider: "openai",
    model: "gpt-4.1-mini",
    warnAtTokens: 1000,
    hooks: {
      onStart: (usage) => console.log("→ start", usage.runId),
      onCall: () => console.log("→ call"),
      onWarn: (_usage, warning) => console.log("⚠ warn:", warning.message),
      onFinish: (usage) =>
        console.log("→ finish", { tokens: usage.totalTokens, cost: usage.estimatedCostUsd }),
    },
  },
);

console.log("Data:", result.data.message);
console.log("Warnings:", result.usage.warnings);
