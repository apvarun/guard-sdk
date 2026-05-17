# @guard-sdk/vercel-ai

Vercel AI SDK adapter for `guard-sdk`.

Wraps `generateText` and `streamText` so calls are automatically bounded by cost, token, call, and timeout limits. Works with any model supported by the Vercel AI SDK.

## Usage

### generateText

```ts
import { generateText } from "ai";
import { createVercelAIGuard } from "@guard-sdk/vercel-ai";

const guarded = createVercelAIGuard(
  { generateText, streamText },
  {
    name: "vercel-ai-text",
    model: "gpt-4o-mini",
    maxCostUsd: 1,
    maxTokens: 5000,
    timeoutMs: 30000,
  },
);

const result = await guarded.generateText({
  model: "gpt-4o-mini",
  prompt: "Summarize this report.",
});

console.log(result.usage);
```

### streamText

```ts
const streamed = guarded.streamText({
  model: "gpt-4o-mini",
  prompt: "Stream a short summary.",
});

for await (const chunk of streamed.textStream) {
  process.stdout.write(chunk);
}
```

## Peer dependency

Requires `ai >=5.0.0` in your project.
