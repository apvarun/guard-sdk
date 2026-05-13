import OpenAI from "openai";
import { createOpenAIGuard } from "@guard-sdk/openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const guardedOpenAI = createOpenAIGuard(openai, {
  name: "basic-openai-example",
  maxCostUsd: 1,
  maxTokens: 5_000,
  timeoutMs: 30_000,
});

const response = await guardedOpenAI.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [{ role: "user", content: "Summarize this report." }],
});

console.log(response.choices[0]?.message?.content);
console.log(response.usage);
