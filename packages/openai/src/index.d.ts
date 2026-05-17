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
export declare function createOpenAIGuard<TParams extends OpenAIChatCompletionCreateParams, TResponse, TClient extends OpenAIClientLike<TParams, TResponse>>(client: TClient, defaultConfig?: OpenAIGuardConfig): TClient & {
    chat: {
        completions: {
            create: (params: TParams, overrides?: OpenAIGuardConfig) => Promise<TResponse>;
        };
    };
};
