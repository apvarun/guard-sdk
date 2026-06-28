import { createGuardAbortSignal, createGuardStreamRun, guard } from "@guard-sdk/core";
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

export type AnthropicClientLike<
  TCreateParams extends AnthropicMessageCreateParams,
  TCreateResponse extends AnthropicMessageLike,
  TStreamParams extends AnthropicMessageCreateParams,
  TStreamResult extends AnthropicMessageStreamLike<TCreateResponse>,
> = {
  messages: {
    create: (params: TCreateParams, options?: AnthropicRequestOptions) => Promise<TCreateResponse>;
    stream: (params: TStreamParams, options?: AnthropicRequestOptions) => TStreamResult;
  };
};

export type AnthropicGuardConfig = Omit<GuardConfig, "provider" | "model"> & {
  model?: string;
};

function pickModel(
  params: AnthropicMessageCreateParams,
  overrides: AnthropicGuardConfig,
  defaults: AnthropicGuardConfig,
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

function hasFinalMessage<TFinalMessage extends AnthropicMessageLike>(
  stream: AnthropicMessageStreamLike<TFinalMessage>,
): stream is AnthropicMessageStreamLike<TFinalMessage> & {
  finalMessage: () => Promise<TFinalMessage>;
} {
  return typeof stream.finalMessage === "function";
}

function hasUntilDone<TFinalMessage extends AnthropicMessageLike>(
  stream: AnthropicMessageStreamLike<TFinalMessage>,
): stream is AnthropicMessageStreamLike<TFinalMessage> & {
  untilDone: () => Promise<void>;
} {
  return typeof stream.untilDone === "function";
}

function wrapAnthropicStream<TFinalMessage extends AnthropicMessageLike, TStreamResult>(
  stream: TStreamResult,
  mergedConfig: GuardConfig,
  onSettled: () => void = () => {},
): TStreamResult {
  const streamLike = stream as AnthropicMessageStreamLike<TFinalMessage>;
  const streamRun = createGuardStreamRun(mergedConfig);
  let finalizePromise: Promise<TFinalMessage | { usage: { total_tokens: number } }> | undefined;

  const ensureFinalized = () => {
    if (!finalizePromise) {
      // Release the timeout/abort wiring as soon as the stream settles.
      onSettled();
      finalizePromise = streamRun
        .then((run) =>
          run.finish(async () => {
            if (hasFinalMessage(streamLike)) {
              return await streamLike.finalMessage();
            }

            if (hasUntilDone(streamLike)) {
              await streamLike.untilDone();
            }

            return {
              usage: {
                total_tokens: 0,
              },
            };
          }),
        )
        .then((result) => result);
    }

    return finalizePromise;
  };

  return new Proxy(stream as object, {
    get(target, property, receiver) {
      if (property === "finalMessage" && hasFinalMessage(streamLike)) {
        return () => ensureFinalized() as Promise<TFinalMessage>;
      }

      if (property === "untilDone" && hasUntilDone(streamLike)) {
        return async () => {
          await ensureFinalized();
        };
      }

      const value = Reflect.get(target, property, receiver);

      if (typeof value === "function") {
        return value.bind(target);
      }

      return value;
    },
  }) as TStreamResult;
}

export function createAnthropicGuard<
  TCreateParams extends AnthropicMessageCreateParams,
  TCreateResponse extends AnthropicMessageLike,
  TStreamParams extends AnthropicMessageCreateParams,
  TStreamResult extends AnthropicMessageStreamLike<TCreateResponse>,
  TClient extends AnthropicClientLike<TCreateParams, TCreateResponse, TStreamParams, TStreamResult>,
>(client: TClient, defaultConfig: AnthropicGuardConfig = {}) {
  const createOriginal = client.messages.create;
  const streamOriginal = client.messages.stream;

  return {
    ...client,
    messages: {
      ...client.messages,
      create: async (params: TCreateParams, overrides: AnthropicGuardConfig = {}) => {
        const model = pickModel(params, overrides, defaultConfig);
        const mergedConfig: GuardConfig = {
          ...defaultConfig,
          ...overrides,
          provider: "anthropic",
          model,
        };

        const { data } = await guard.run(
          async ({ signal }) => createOriginal.call(client.messages, params, { signal }),
          mergedConfig,
        );

        return data;
      },
      stream: (params: TStreamParams, overrides: AnthropicGuardConfig = {}) => {
        const model = pickModel(params, overrides, defaultConfig);
        const mergedConfig: GuardConfig = {
          ...defaultConfig,
          ...overrides,
          provider: "anthropic",
          model,
        };

        // Pass a timeout-aware signal so `timeoutMs` can actually abort an
        // in-flight stream (it is otherwise only enforced inside `guard.run`,
        // which does not wrap the eagerly-created stream).
        const { signal, dispose } = createGuardAbortSignal(mergedConfig);
        const stream = streamOriginal.call(client.messages, params, { signal });
        return wrapAnthropicStream<TCreateResponse, TStreamResult>(stream, mergedConfig, dispose);
      },
    },
  };
}
