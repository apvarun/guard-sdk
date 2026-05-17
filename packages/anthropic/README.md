# @guard-sdk/anthropic

Anthropic messages adapter for `guard-sdk`.

Wraps an Anthropic client instance so that `messages.create` calls are automatically bounded by cost, token, call, and timeout limits. Stream finalization is also supported.

## Usage

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicGuard } from "@guard-sdk/anthropic";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const guarded = createAnthropicGuard(anthropic, {
  name: "anthropic-message",
  maxCostUsd: 1,
  maxTokens: 5000,
  timeoutMs: 30000,
});

const response = await guarded.messages.create({
  model: "claude-opus-4-1-20250805",
  messages: [{ role: "user", content: "Summarize this." }],
});

console.log(response.usage);
```

## Peer dependency

Requires `@anthropic-ai/sdk >=0.61.0 <1` in your project.
