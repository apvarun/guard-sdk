import { guard } from "@guard-sdk/core";
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

export type VercelFunctionsLike<
  TGenerateTextParams extends VercelGenerateTextParams,
  TGenerateTextResult extends VercelGenerateTextResultLike,
  TStreamTextParams extends VercelStreamTextParams,
  TStreamResult extends VercelStreamResultLike,
> = {
  generateText: (params: TGenerateTextParams) => Promise<TGenerateTextResult>;
  streamText: (params: TStreamTextParams) => TStreamResult;
};

export type VercelAIGuardConfig = Omit<GuardConfig, "provider" | "model"> & {
  model?: string;
};

type GuardUsageEnvelope = {
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function pickModel(
  params: VercelGenerateTextParams | VercelStreamTextParams,
  overrides: VercelAIGuardConfig,
  defaults: VercelAIGuardConfig,
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

function normalizeUsage(usage: unknown): GuardUsageEnvelope["usage"] | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;

  const inputTokens = toFiniteNumber(record.promptTokens) ?? toFiniteNumber(record.inputTokens);
  const outputTokens =
    toFiniteNumber(record.completionTokens) ?? toFiniteNumber(record.outputTokens);
  const totalTokens = toFiniteNumber(record.totalTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens:
      totalTokens ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined),
  };
}

function usageFromGenerateTextResult(result: unknown): GuardUsageEnvelope | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const usage = normalizeUsage((result as { usage?: unknown }).usage);

  if (!usage) {
    return undefined;
  }

  return { usage };
}

function asPromise<T>(value: PromiseLike<T> | T): Promise<T> {
  return Promise.resolve(value);
}

async function readStreamUsage(result: VercelStreamResultLike): Promise<GuardUsageEnvelope> {
  if (result.totalUsage !== undefined) {
    const normalized = normalizeUsage(await asPromise(result.totalUsage));

    if (normalized) {
      return { usage: normalized };
    }
  }

  if (result.usage !== undefined) {
    const normalized = normalizeUsage(await asPromise(result.usage));

    if (normalized) {
      return { usage: normalized };
    }
  }

  return {
    usage: {
      total_tokens: 0,
    },
  };
}

function wrapTerminalPromise<T>(promise: Promise<T>, finalize: () => Promise<void>) {
  return promise.then(
    async (value) => {
      await finalize();
      return value;
    },
    async (error) => {
      await finalize();
      throw error;
    },
  );
}

function wrapAsyncIterable<T>(
  source: AsyncIterable<T>,
  finalize: () => Promise<void>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();

      return {
        next: async (...args: [] | [unknown]) => {
          const result = await iterator.next(...(args as []));

          if (result.done) {
            await finalize();
          }

          return result;
        },
        return: async (value?: unknown) => {
          if (typeof iterator.return === "function") {
            const returned = await iterator.return(value);
            await finalize();
            return returned;
          }

          await finalize();
          return { done: true, value: value as T };
        },
        throw: async (error?: unknown) => {
          if (typeof iterator.throw === "function") {
            const thrown = await iterator.throw(error);
            await finalize();
            return thrown;
          }

          await finalize();
          throw error;
        },
      };
    },
  };
}

function wrapStreamResult<TStreamResult extends VercelStreamResultLike>(
  streamResult: TStreamResult,
  mergedConfig: GuardConfig,
): TStreamResult {
  let finalizePromise: Promise<void> | undefined;

  const finalize = () => {
    if (!finalizePromise) {
      finalizePromise = guard
        .run(async () => readStreamUsage(streamResult), mergedConfig)
        .then(() => undefined);
    }

    return finalizePromise;
  };

  return new Proxy(streamResult as object, {
    get(target, property, receiver) {
      if (property === "text") {
        const value = Reflect.get(target, property, receiver);

        if (value === undefined) {
          return value;
        }

        return wrapTerminalPromise(asPromise(value), finalize);
      }

      if (property === "usage") {
        const value = Reflect.get(target, property, receiver);

        if (value === undefined) {
          return value;
        }

        return wrapTerminalPromise(asPromise(value), finalize);
      }

      if (property === "totalUsage") {
        const value = Reflect.get(target, property, receiver);

        if (value === undefined) {
          return value;
        }

        return wrapTerminalPromise(asPromise(value), finalize);
      }

      if (property === "consumeStream") {
        const value = Reflect.get(target, property, receiver);

        if (typeof value !== "function") {
          return value;
        }

        return async (options?: unknown) => {
          await (value as (options?: unknown) => Promise<void>).call(target, options);
          await finalize();
        };
      }

      if (property === "textStream") {
        const value = Reflect.get(target, property, receiver);

        if (
          !value ||
          typeof value !== "object" ||
          Symbol.asyncIterator in (value as object) === false
        ) {
          return value;
        }

        return wrapAsyncIterable(value as AsyncIterable<unknown>, finalize);
      }

      if (property === "fullStream") {
        const value = Reflect.get(target, property, receiver);

        if (
          !value ||
          typeof value !== "object" ||
          Symbol.asyncIterator in (value as object) === false
        ) {
          return value;
        }

        return wrapAsyncIterable(value as AsyncIterable<unknown>, finalize);
      }

      const value = Reflect.get(target, property, receiver);

      if (typeof value === "function") {
        return value.bind(target);
      }

      return value;
    },
  }) as TStreamResult;
}

export function createVercelAIGuard<
  TGenerateTextParams extends VercelGenerateTextParams,
  TGenerateTextResult extends VercelGenerateTextResultLike,
  TStreamTextParams extends VercelStreamTextParams,
  TStreamResult extends VercelStreamResultLike,
>(
  functions: VercelFunctionsLike<
    TGenerateTextParams,
    TGenerateTextResult,
    TStreamTextParams,
    TStreamResult
  >,
  defaultConfig: VercelAIGuardConfig = {},
) {
  const generateTextOriginal = functions.generateText;
  const streamTextOriginal = functions.streamText;

  return {
    ...functions,
    generateText: async (params: TGenerateTextParams, overrides: VercelAIGuardConfig = {}) => {
      const model = pickModel(params, overrides, defaultConfig);
      const mergedConfig: GuardConfig = {
        ...defaultConfig,
        ...overrides,
        provider: "vercel-ai",
        model,
      };

      let response: TGenerateTextResult | undefined;

      await guard.run(async () => {
        response = await generateTextOriginal(params);
        return usageFromGenerateTextResult(response) ?? response;
      }, mergedConfig);

      return response as TGenerateTextResult;
    },
    streamText: (params: TStreamTextParams, overrides: VercelAIGuardConfig = {}) => {
      const model = pickModel(params, overrides, defaultConfig);
      const mergedConfig: GuardConfig = {
        ...defaultConfig,
        ...overrides,
        provider: "vercel-ai",
        model,
      };

      const streamResult = streamTextOriginal(params);
      return wrapStreamResult(streamResult, mergedConfig);
    },
  };
}
