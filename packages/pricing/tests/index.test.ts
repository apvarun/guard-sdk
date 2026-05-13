import { expect, test } from "vite-plus/test";
import { createPricingResolver, getModelPricing } from "../src/index.ts";

test("createPricingResolver resolves known entries", () => {
  const resolver = createPricingResolver([
    {
      provider: "openai",
      model: "gpt-test",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    },
  ]);

  expect(resolver.getPricing("openai", "gpt-test")).toEqual({
    provider: "openai",
    model: "gpt-test",
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
  });
});

test("getModelPricing returns default model entries", () => {
  expect(getModelPricing("openai", "gpt-4.1-mini")).toBeDefined();
  expect(getModelPricing("openai", "unknown-model")).toBeUndefined();
});
