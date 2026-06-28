import { createGuardAbortSignal, createGuardStreamRun, guard } from "@guard-sdk/core";
import type { GuardConfig, GuardStreamRun } from "@guard-sdk/core";

export type OpenAIChatCompletionCreateParams = {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
};

export type OpenAIRequestOptions = {
  signal?: AbortSignal;
  [key: string]: unknown;
};

export type OpenAIClientLike<TParams extends OpenAIChatCompletionCreateParams, TResponse> = {
  chat: {
    completions: {
      create: (params: TParams, options?: OpenAIRequestOptions) => Promise<TResponse>;
    };
  };
};

export type OpenAIGuardConfig = Omit<GuardConfig, "provider" | "model"> & {
  model?: string;
};

type OpenAIChunkLike = {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
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

function isAsyncIterable(value: unknown): value is AsyncIterable<OpenAIChunkLike> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    Symbol.asyncIterator in (value as object)
  );
}

/**
 * Wraps a streaming response so guard usage is finalized once the stream
 * completes. Token usage is read from the final chunk, which OpenAI only emits
 * when the request sets `stream_options: { include_usage: true }`.
 */
function wrapOpenAIStream<TStream>(
  stream: TStream,
  streamRun: GuardStreamRun,
  onSettled: () => void = () => {},
): TStream {
  if (!isAsyncIterable(stream)) {
    onSettled();
    return stream;
  }

  let lastUsage: OpenAIChunkLike["usage"];
  let finalizePromise: Promise<void> | undefined;

  const finalize = () => {
    if (!finalizePromise) {
      // Release the timeout/abort wiring as soon as the stream settles.
      onSettled();
      finalizePromise = streamRun
        .finish(() => ({ usage: lastUsage ?? { total_tokens: 0 } }))
        .then(() => undefined);
    }

    return finalizePromise;
  };

  return new Proxy(stream as object, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return () => {
          const iterator = (target as AsyncIterable<OpenAIChunkLike>)[Symbol.asyncIterator]();

          return {
            next: async (...args: [] | [unknown]) => {
              try {
                const result = await iterator.next(...(args as []));

                if (result.done) {
                  await finalize();
                } else if (result.value?.usage) {
                  lastUsage = result.value.usage;
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
              return { done: true, value: value as OpenAIChunkLike };
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
        };
      }

      const value = Reflect.get(target, property, receiver);

      if (typeof value === "function") {
        return value.bind(target);
      }

      return value;
    },
  }) as TStream;
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

          if (params.stream === true) {
            // Enforce the limits that are knowable up front before initiating
            // the streaming request, then finalize real usage once it drains.
            const streamRun = await createGuardStreamRun(mergedConfig);

            // Default to include_usage so OpenAI emits the final usage chunk;
            // without it the stream reports no tokens and budgets never move.
            const existingStreamOptions =
              (params.stream_options as Record<string, unknown> | undefined) ?? {};
            const streamParams = {
              ...params,
              stream_options: { include_usage: true, ...existingStreamOptions },
            } as TParams;

            const { signal, dispose } = createGuardAbortSignal(mergedConfig);

            let stream: TResponse;
            try {
              stream = await createOriginal.call(client.chat.completions, streamParams, { signal });
            } catch (error) {
              dispose();
              await streamRun.finish(() => {
                throw error;
              });
              throw error;
            }

            return wrapOpenAIStream(stream, streamRun, dispose);
          }

          const { data } = await guard.run(
            async ({ signal }) => createOriginal.call(client.chat.completions, params, { signal }),
            mergedConfig,
          );

          return data;
        },
      },
    },
  };
}
