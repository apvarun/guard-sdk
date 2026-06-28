export type ModelPricing = {
  provider: string;
  model: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  tiers?: ModelPricingTier[];
};

export type ModelPricingContext = {
  inputTokens?: number;
  totalTokens?: number;
};

export type ModelPricingTier = {
  inputTokenLimit?: number;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
};

export type PricingResolver = {
  getPricing: (
    provider: string,
    model: string,
    context?: ModelPricingContext,
  ) => ModelPricing | undefined;
};

// Prices are per million tokens (USD) and are best-effort estimates. Providers
// change pricing frequently — override with `createPricingResolverWithDefaults`
// or a custom resolver when exact accounting matters.
const DEFAULT_PRICING: ModelPricing[] = [
  // OpenAI
  { provider: "openai", model: "gpt-4.1", inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 0.4,
    outputPerMillionTokens: 1.6,
  },
  {
    provider: "openai",
    model: "gpt-4.1-nano",
    inputPerMillionTokens: 0.1,
    outputPerMillionTokens: 0.4,
  },
  { provider: "openai", model: "gpt-4o", inputPerMillionTokens: 2.5, outputPerMillionTokens: 10 },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPerMillionTokens: 0.15,
    outputPerMillionTokens: 0.6,
  },
  { provider: "openai", model: "o1", inputPerMillionTokens: 15, outputPerMillionTokens: 60 },
  { provider: "openai", model: "o1-mini", inputPerMillionTokens: 1.1, outputPerMillionTokens: 4.4 },

  // Anthropic
  {
    provider: "anthropic",
    model: "claude-opus-4",
    inputPerMillionTokens: 15,
    outputPerMillionTokens: 75,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
  },
  {
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
  },
  {
    provider: "anthropic",
    model: "claude-3-5-haiku",
    inputPerMillionTokens: 0.8,
    outputPerMillionTokens: 4,
  },
  {
    provider: "anthropic",
    model: "claude-3-opus",
    inputPerMillionTokens: 15,
    outputPerMillionTokens: 75,
  },
  {
    provider: "anthropic",
    model: "claude-3-haiku",
    inputPerMillionTokens: 0.25,
    outputPerMillionTokens: 1.25,
  },

  // Google Gemini
  {
    provider: "google",
    model: "gemini-2.5-pro",
    inputPerMillionTokens: 1.25,
    outputPerMillionTokens: 10,
    tiers: [
      { inputTokenLimit: 200_000, inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
      { inputPerMillionTokens: 2.5, outputPerMillionTokens: 15 },
    ],
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    inputPerMillionTokens: 0.3,
    outputPerMillionTokens: 2.5,
  },
  {
    provider: "google",
    model: "gemini-2.0-flash",
    inputPerMillionTokens: 0.1,
    outputPerMillionTokens: 0.4,
  },
  {
    provider: "google",
    model: "gemini-1.5-pro",
    inputPerMillionTokens: 1.25,
    outputPerMillionTokens: 5,
  },
  {
    provider: "google",
    model: "gemini-1.5-flash",
    inputPerMillionTokens: 0.075,
    outputPerMillionTokens: 0.3,
  },
];

function key(provider: string, model: string) {
  return `${provider.trim().toLowerCase()}::${model.trim().toLowerCase()}`;
}

function createPricingIndex(entries: ModelPricing[]) {
  const index = new Map<string, ModelPricing>();

  for (const entry of entries) {
    index.set(key(entry.provider, entry.model), entry);
  }

  return index;
}

function pickPricingTier(
  entry: ModelPricing,
  context: ModelPricingContext | undefined,
): ModelPricing {
  if (!entry.tiers || entry.tiers.length === 0) {
    return entry;
  }

  const inputTokens = context?.inputTokens ?? context?.totalTokens ?? 0;
  const tier =
    entry.tiers.find(
      (candidate) =>
        candidate.inputTokenLimit === undefined || inputTokens <= candidate.inputTokenLimit,
    ) ?? entry.tiers.at(-1);

  if (!tier) {
    return entry;
  }

  return {
    ...entry,
    inputPerMillionTokens: tier.inputPerMillionTokens,
    outputPerMillionTokens: tier.outputPerMillionTokens,
  };
}

export function createPricingResolver(entries: ModelPricing[]): PricingResolver {
  const index = createPricingIndex(entries);

  return {
    getPricing(provider: string, model: string, context?: ModelPricingContext) {
      const entry = index.get(key(provider, model));
      return entry ? pickPricingTier(entry, context) : undefined;
    },
  };
}

const defaultResolver = createPricingResolver(DEFAULT_PRICING);

export function createPricingResolverWithDefaults(overrides: ModelPricing[]): PricingResolver {
  const overrideResolver = createPricingResolver(overrides);

  return {
    getPricing(provider: string, model: string, context?: ModelPricingContext) {
      return (
        overrideResolver.getPricing(provider, model, context) ??
        defaultResolver.getPricing(provider, model, context)
      );
    },
  };
}

export function getModelPricing(
  provider: string,
  model: string,
  context?: ModelPricingContext,
): ModelPricing | undefined {
  return defaultResolver.getPricing(provider, model, context);
}
