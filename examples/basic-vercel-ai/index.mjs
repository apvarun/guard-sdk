import { openai } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import { createVercelAIGuard } from "@guard-sdk/vercel-ai";

const guardedAI = createVercelAIGuard(
  { generateText, streamText },
  {
    name: "basic-vercel-ai-example",
    model: "gpt-4o-mini",
    maxCostUsd: 1,
    maxTokens: 5_000,
    timeoutMs: 30_000,
  },
);

const response = await guardedAI.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Summarize this report.",
});

console.log(response.text);
console.log(response.usage);

const stream = guardedAI.streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short summary.",
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}

process.stdout.write("\n");
console.log(await stream.totalUsage);
