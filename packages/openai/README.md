# @guard-sdk/openai

OpenAI chat completions adapter for `guard-sdk`.

Wraps an OpenAI client instance so that `chat.completions.create` calls are automatically bounded by cost, token, call, and timeout limits.

## Usage

```ts
import OpenAI from "openai";
import { createOpenAIGuard } from "@guard-sdk/openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const guarded = createOpenAIGuard(openai, {
  name: "chat-completion",
  maxCostUsd: 1,
  maxTokens: 5000,
  timeoutMs: 30000,
});

const response = await guarded.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [{ role: "user", content: "Hello." }],
});

console.log(response.usage);
```

## Peer dependency

Requires `openai >=6.0.0` in your project.
