import type { GuardConfig } from "@guard-sdk/core";
export type AnthropicMessageCreateParams = {
    model?: string;
    [key: string]: unknown;
};
export type AnthropicMessageLike = {
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};
export type AnthropicMessageStreamLike<TFinalMessage extends AnthropicMessageLike> = {
    finalMessage?: () => Promise<TFinalMessage>;
    untilDone?: () => Promise<void>;
    [key: string]: unknown;
};
export type AnthropicRequestOptions = {
    signal?: AbortSignal;
    [key: string]: unknown;
};
export type AnthropicClientLike<TCreateParams extends AnthropicMessageCreateParams, TCreateResponse extends AnthropicMessageLike, TStreamParams extends AnthropicMessageCreateParams, TStreamResult extends AnthropicMessageStreamLike<TCreateResponse>> = {
    messages: {
        create: (params: TCreateParams, options?: AnthropicRequestOptions) => Promise<TCreateResponse>;
        stream: (params: TStreamParams, options?: AnthropicRequestOptions) => TStreamResult;
    };
};
export type AnthropicGuardConfig = Omit<GuardConfig, "provider" | "model"> & {
    model?: string;
};
export declare function createAnthropicGuard<TCreateParams extends AnthropicMessageCreateParams, TCreateResponse extends AnthropicMessageLike, TStreamParams extends AnthropicMessageCreateParams, TStreamResult extends AnthropicMessageStreamLike<TCreateResponse>, TClient extends AnthropicClientLike<TCreateParams, TCreateResponse, TStreamParams, TStreamResult>>(client: TClient, defaultConfig?: AnthropicGuardConfig): TClient & {
    messages: {
        create: (params: TCreateParams, overrides?: AnthropicGuardConfig) => Promise<any>;
        stream: (params: TStreamParams, overrides?: AnthropicGuardConfig) => TStreamResult;
    };
};
