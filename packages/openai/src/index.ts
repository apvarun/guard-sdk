import { guard } from "@guard-sdk/core";
import type { GuardConfig } from "@guard-sdk/core";

export type OpenAIChatCompletionCreateParams = {
  model?: string;
  [key: string]: unknown;
};

export type OpenAIClientLike<TParams extends OpenAIChatCompletionCreateParams, TResponse> = {
  chat: {
    completions: {
      create: (params: TParams) => Promise<TResponse>;
    };
  };
};

export type OpenAIGuardConfig = Omit<GuardConfig, "provider" | "model"> & {
  model?: string;
};

function pickModel(
  params: OpenAIChatCompletionCreateParams,
  overrides: OpenAIGuardConfig,
  defaults: OpenAIGuardConfig,
): string | undefined {
  if (typeof params.model === "string" && params.model.length > 0) {
    return params.model;
  }

  if (typeof overrides.model === "string" && overrides.model.length > 0) {
    return overrides.model;
  }

  if (typeof defaults.model === "string" && defaults.model.length > 0) {
    return defaults.model;
  }

  return undefined;
}

export function createOpenAIGuard<
  TParams extends OpenAIChatCompletionCreateParams,
  TResponse,
  TClient extends OpenAIClientLike<TParams, TResponse>,
>(client: TClient, defaultConfig: OpenAIGuardConfig = {}) {
  const createOriginal = client.chat.completions.create;

  return {
    ...client,
    chat: {
      ...client.chat,
      completions: {
        ...client.chat.completions,
        create: async (params: TParams, overrides: OpenAIGuardConfig = {}): Promise<TResponse> => {
          const model = pickModel(params, overrides, defaultConfig);
          const mergedConfig: GuardConfig = {
            ...defaultConfig,
            ...overrides,
            provider: "openai",
            model,
          };

          const { data } = await guard.run(
            async () => createOriginal.call(client.chat.completions, params),
            mergedConfig,
          );

          return data;
        },
      },
    },
  };
}
