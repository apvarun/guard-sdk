import type { GuardConfig } from "@guard-sdk/core";
export type VercelUsageLike = {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
};
export type VercelGenerateTextResultLike = {
    usage?: VercelUsageLike;
    [key: string]: unknown;
};
export type VercelStreamResultLike = {
    text?: PromiseLike<string>;
    usage?: PromiseLike<VercelUsageLike> | VercelUsageLike;
    totalUsage?: PromiseLike<VercelUsageLike> | VercelUsageLike;
    consumeStream?: (options?: unknown) => Promise<void>;
    textStream?: AsyncIterable<unknown>;
    fullStream?: AsyncIterable<unknown>;
    [key: string]: unknown;
};
export type VercelGenerateTextParams = {
    model?: string;
    [key: string]: unknown;
};
export type VercelStreamTextParams = {
    model?: string;
    [key: string]: unknown;
};
export type VercelFunctionsLike<TGenerateTextParams extends VercelGenerateTextParams, TGenerateTextResult extends VercelGenerateTextResultLike, TStreamTextParams extends VercelStreamTextParams, TStreamResult extends VercelStreamResultLike> = {
    generateText: (params: TGenerateTextParams) => Promise<TGenerateTextResult>;
    streamText: (params: TStreamTextParams) => TStreamResult;
};
export type VercelAIGuardConfig = Omit<GuardConfig, "provider" | "model"> & {
    model?: string;
};
export declare function createVercelAIGuard<TGenerateTextParams extends VercelGenerateTextParams, TGenerateTextResult extends VercelGenerateTextResultLike, TStreamTextParams extends VercelStreamTextParams, TStreamResult extends VercelStreamResultLike>(functions: VercelFunctionsLike<TGenerateTextParams, TGenerateTextResult, TStreamTextParams, TStreamResult>, defaultConfig?: VercelAIGuardConfig): {
    generateText: (params: TGenerateTextParams, overrides?: VercelAIGuardConfig) => Promise<TGenerateTextResult>;
    streamText: (params: TStreamTextParams, overrides?: VercelAIGuardConfig) => TStreamResult;
};
