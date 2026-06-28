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
    getPricing: (provider: string, model: string, context?: ModelPricingContext) => ModelPricing | undefined;
};
export declare function createPricingResolver(entries: ModelPricing[]): PricingResolver;
export declare function createPricingResolverWithDefaults(overrides: ModelPricing[]): PricingResolver;
export declare function getModelPricing(provider: string, model: string, context?: ModelPricingContext): ModelPricing | undefined;
