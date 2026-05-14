# @guard-sdk/pricing

Pricing resolver utilities used by `@guard-sdk/core`.

## APIs

- `createPricingResolver(entries)`: use only the entries you provide.
- `createPricingResolverWithDefaults(overrides)`: override selected models and fall back to bundled defaults.
- `getModelPricing(provider, model)`: direct lookup from bundled defaults.

## Example: full custom table

```ts
import { createPricingResolver } from "@guard-sdk/pricing";

const pricing = createPricingResolver([
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 0.4,
    outputPerMillionTokens: 1.6,
  },
]);
```

## Example: override + default fallback

```ts
import { createPricingResolverWithDefaults } from "@guard-sdk/pricing";

const pricing = createPricingResolverWithDefaults([
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionTokens: 0.35,
    outputPerMillionTokens: 1.4,
  },
]);
```
