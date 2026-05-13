import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicGuard } from "@guard-sdk/anthropic";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const guardedAnthropic = createAnthropicGuard(anthropic, {
  name: "basic-anthropic-example",
  maxCostUsd: 1,
  maxTokens: 5_000,
  timeoutMs: 30_000,
});

const response = await guardedAnthropic.messages.create({
  model: "claude-opus-4-1-20250805",
  messages: [{ role: "user", content: "Summarize this report." }],
});

console.log(response.content[0]?.text);
console.log(response.usage);

const stream = guardedAnthropic.messages.stream({
  model: "claude-opus-4-1-20250805",
  messages: [{ role: "user", content: "Stream a short summary." }],
});

const finalStreamMessage = await stream.finalMessage();
console.log(finalStreamMessage.content[0]?.text);
console.log(finalStreamMessage.usage);
