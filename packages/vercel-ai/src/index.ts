import { createGuardAbortSignal, createGuardStreamRun, guard } from "@guard-sdk/core";
import type { GuardConfig } from "@guard-sdk/core";

/**
 * Merges the guard's signal with a caller-supplied `params.abortSignal` so
 * wrapping a call never silently disables the caller's own cancellation.
 * Returns `undefined` only when neither side provides a signal.
 */
function combineAbortSignals(
  primary: AbortSignal | undefined,
  extra: unknown,
): { signal: AbortSignal | undefined; dispose: () => void } {
  const extraSignal = extra instanceof AbortSignal ? extra : undefined;

  if (!primary) {
    return { signal: extraSignal, dispose: () => {} };
  }

  if (!extraSignal) {
    return { signal: primary, dispose: () => {} };
  }

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([primary, extraSignal]), dispose: () => {} };
  }

  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  const link = (source: AbortSignal) => {
    if (source.aborted) {
      controller.abort((source as { reason?: unknown }).reason);
      return;
    }

    const onAbort = () => controller.abort((source as { reason?: unknown }).reason);
    source.addEventListener("abort", onAbort, { once: true });
    cleanup.push(() => source.removeEventListener("abort", onAbort));
  };

  link(primary);
  link(extraSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      for (const fn of cleanup) {
        fn();
      }

      cleanup.length = 0;
    },
  };
}

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

function extractTokenWithFallback(
  record: Record<string, unknown>,
  primary: string,
  fallback: string,
): number | undefined {
  return toFiniteNumber(record[primary]) ?? toFiniteNumber(record[fallback]);
}

function calculateTotalTokens(
  explicitTotal: number | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (explicitTotal !== undefined) {
    return explicitTotal;
  }

  if (inputTokens !== undefined || outputTokens !== undefined) {
    return (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  return undefined;
}

function normalizeUsage(usage: unknown): GuardUsageEnvelope["usage"] | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;

  const inputTokens = extractTokenWithFallback(record, "promptTokens", "inputTokens");
  const outputTokens = extractTokenWithFallback(record, "completionTokens", "outputTokens");
  const totalTokens = toFiniteNumber(record.totalTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const calculatedTotal = calculateTotalTokens(totalTokens, inputTokens, outputTokens);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: calculatedTotal,
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
          try {
            const result = await iterator.next(...(args as []));

            if (result.done) {
              await finalize();
            }

            return result;
          } catch (error) {
            await finalize();
            throw error;
          }
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

function handlePromiseProperty<T>(
  target: object,
  property: PropertyKey,
  receiver: unknown,
  finalize: () => Promise<void>,
): Promise<T> | undefined {
  const value = Reflect.get(target, property, receiver);

  if (value === undefined) {
    return value as undefined;
  }

  return wrapTerminalPromise(asPromise(value as PromiseLike<T> | T), finalize);
}

function handleConsumeStreamProperty(
  target: object,
  property: PropertyKey,
  finalize: () => Promise<void>,
): ((options?: unknown) => Promise<void>) | undefined {
  const value = Reflect.get(target, property);

  if (typeof value !== "function") {
    return value as undefined;
  }

  return async (options?: unknown) => {
    await (value as (options?: unknown) => Promise<void>).call(target, options);
    await finalize();
  };
}

function handleAsyncIterableProperty(
  target: object,
  property: PropertyKey,
  finalize: () => Promise<void>,
): AsyncIterable<unknown> | undefined {
  const value = Reflect.get(target, property);

  if (!value || typeof value !== "object" || Symbol.asyncIterator in (value as object) === false) {
    return value as undefined;
  }

  return wrapAsyncIterable(value as AsyncIterable<unknown>, finalize);
}

function handleDefaultProperty(target: object, property: PropertyKey, receiver: unknown): unknown {
  const value = Reflect.get(target, property, receiver);

  if (typeof value === "function") {
    return (value as (...args: unknown[]) => unknown).bind(target);
  }

  return value;
}

function wrapStreamResult<TStreamResult extends VercelStreamResultLike>(
  streamResult: TStreamResult,
  mergedConfig: GuardConfig,
  onSettled: () => void = () => {},
): TStreamResult {
  const streamRun = createGuardStreamRun(mergedConfig);
  let finalizePromise: Promise<void> | undefined;

  const finalize = (): Promise<void> => {
    if (!finalizePromise) {
      // Release the timeout/abort wiring as soon as the stream settles.
      onSettled();
      finalizePromise = streamRun
        .then((run) => run.finish(() => readStreamUsage(streamResult)))
        .then(() => undefined);
    }

    return finalizePromise;
  };

  return new Proxy(streamResult as object, {
    get(target, property, receiver) {
      if (property === "text" || property === "usage" || property === "totalUsage") {
        return handlePromiseProperty(target, property, receiver, finalize);
      }

      if (property === "consumeStream") {
        return handleConsumeStreamProperty(target, property, finalize);
      }

      if (property === "textStream" || property === "fullStream") {
        return handleAsyncIterableProperty(target, property, finalize);
      }

      return handleDefaultProperty(target, property, receiver);
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

      await guard.run(async ({ signal }) => {
        const combined = combineAbortSignals(signal, params.abortSignal);

        try {
          response = await generateTextOriginal({ ...params, abortSignal: combined.signal });
          return usageFromGenerateTextResult(response) ?? response;
        } finally {
          combined.dispose();
        }
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

      // Build a timeout-aware signal (streamText is not wrapped by guard.run,
      // so timeoutMs would otherwise never abort the stream) and merge it with
      // any caller-supplied abortSignal so neither cancellation path is lost.
      const { signal, dispose } = createGuardAbortSignal(mergedConfig);
      const combined = combineAbortSignals(signal, params.abortSignal);
      const streamParams = combined.signal ? { ...params, abortSignal: combined.signal } : params;
      const streamResult = streamTextOriginal(streamParams);

      return wrapStreamResult(streamResult, mergedConfig, () => {
        combined.dispose();
        dispose();
      });
    },
  };
}
