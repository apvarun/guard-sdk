import { expect, test } from "vite-plus/test";
import {
  createPricingResolver,
  createPricingResolverWithDefaults,
  getModelPricing,
} from "../src/index.ts";

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

test("createPricingResolverWithDefaults prioritizes overrides", () => {
  const resolver = createPricingResolverWithDefaults([
    {
      provider: "openai",
      model: "gpt-4.1-mini",
      inputPerMillionTokens: 9,
      outputPerMillionTokens: 9,
    },
  ]);

  expect(resolver.getPricing("openai", "gpt-4.1-mini")).toEqual({
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 9,
    outputPerMillionTokens: 9,
  });
});

test("createPricingResolverWithDefaults falls back to bundled defaults", () => {
  const resolver = createPricingResolverWithDefaults([
    {
      provider: "openai",
      model: "custom-model",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
    },
  ]);

  expect(resolver.getPricing("openai", "gpt-4.1-mini")).toBeDefined();
  expect(resolver.getPricing("openai", "unknown-model")).toBeUndefined();
});

test("createPricingResolverWithDefaults keeps key normalization parity", () => {
  const resolver = createPricingResolverWithDefaults([
    {
      provider: " OPENAI ",
      model: " GPT-4.1-MINI ",
      inputPerMillionTokens: 7,
      outputPerMillionTokens: 8,
    },
  ]);

  expect(resolver.getPricing("openai", "gpt-4.1-mini")).toEqual({
    provider: " OPENAI ",
    model: " GPT-4.1-MINI ",
    inputPerMillionTokens: 7,
    outputPerMillionTokens: 8,
  });
});

test("default catalog covers current OpenAI, Anthropic, and Google models", () => {
  expect(getModelPricing("openai", "gpt-4o")).toMatchObject({
    inputPerMillionTokens: 2.5,
    outputPerMillionTokens: 10,
  });
  expect(getModelPricing("anthropic", "claude-sonnet-4")).toMatchObject({
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
  });
  expect(getModelPricing("google", "gemini-2.5-pro")).toMatchObject({
    inputPerMillionTokens: 1.25,
    outputPerMillionTokens: 10,
  });
});

test("stale OpenAI o-series defaults are not bundled", () => {
  expect(getModelPricing("openai", "o3")).toBeUndefined();
  expect(getModelPricing("openai", "o3-mini")).toBeUndefined();
  expect(getModelPricing("openai", "o4-mini")).toBeUndefined();
});

test("Gemini 2.5 Pro resolves tiered pricing from context", () => {
  expect(getModelPricing("google", "gemini-2.5-pro", { inputTokens: 200_000 })).toMatchObject({
    inputPerMillionTokens: 1.25,
    outputPerMillionTokens: 10,
  });

  expect(getModelPricing("google", "gemini-2.5-pro", { inputTokens: 200_001 })).toMatchObject({
    inputPerMillionTokens: 2.5,
    outputPerMillionTokens: 15,
  });
});

test("default catalog lookup is case- and whitespace-insensitive", () => {
  expect(getModelPricing("OpenAI", "  GPT-4O  ")).toBeDefined();
  expect(getModelPricing("anthropic", "claude-unknown-model")).toBeUndefined();
});
