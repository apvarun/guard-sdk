import { CallLimitExceededError, guard } from "@guard-sdk/core";

const run = guard.createRun({
  name: "agent-loop-example",
  maxCalls: 2,
  maxRetries: 1,
});

await run.call("step-1", async () => ({ usage: { total_tokens: 120 } }));
await run.call("step-2", async () => ({ usage: { total_tokens: 90 } }));

try {
  await run.call("step-3", async () => ({ usage: { total_tokens: 80 } }));
} catch (error) {
  if (error instanceof CallLimitExceededError) {
    console.log("Blocked as expected:", error.code);
  }
}

console.log("Summary:", run.summary());
