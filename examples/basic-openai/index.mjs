import { createOpenAIGuard } from "@guard-sdk/openai";

// Mocked OpenAI-like client to keep the example runnable without API keys.
const openai = {
  chat: {
    completions: {
      async create(params) {
        return {
          id: "chatcmpl_demo",
          model: params.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Guarded OpenAI call completed.",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
          },
        };
      },
    },
  },
};

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
