export type ModelPricing = {
  provider: string;
  model: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
};

export type PricingResolver = {
  getPricing: (provider: string, model: string) => ModelPricing | undefined;
};

const DEFAULT_PRICING: ModelPricing[] = [
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 0.4,
    outputPerMillionTokens: 1.6,
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 8,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPerMillionTokens: 0.15,
    outputPerMillionTokens: 0.6,
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

export function createPricingResolver(entries: ModelPricing[]): PricingResolver {
  const index = createPricingIndex(entries);

  return {
    getPricing(provider: string, model: string) {
      return index.get(key(provider, model));
    },
  };
}

const defaultResolver = createPricingResolver(DEFAULT_PRICING);

export function createPricingResolverWithDefaults(overrides: ModelPricing[]): PricingResolver {
  const overrideResolver = createPricingResolver(overrides);

  return {
    getPricing(provider: string, model: string) {
      return (
        overrideResolver.getPricing(provider, model) ?? defaultResolver.getPricing(provider, model)
      );
    },
  };
}

export function getModelPricing(provider: string, model: string): ModelPricing | undefined {
  return defaultResolver.getPricing(provider, model);
}
