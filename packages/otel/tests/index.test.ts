import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vite-plus/test";
import { createMemoryLogger, guard } from "@guard-sdk/core";
import {
  createOpenTelemetryLogger,
  GUARD_TELEMETRY_ATTRIBUTE_KEYS,
  GUARD_TELEMETRY_SCHEMA_VERSION,
  OPEN_TELEMETRY_SPAN_STATUS_CODE,
  toGuardTelemetryAttributes,
  type GuardTelemetryAttributes,
  type OpenTelemetryLogRecord,
  type OpenTelemetrySpan,
  type OpenTelemetrySpanStatus,
  type OpenTelemetryTracer,
} from "../src/index.ts";

type CapturedSpan = {
  name: string;
  startAttributes?: GuardTelemetryAttributes;
  setAttributesCalls: GuardTelemetryAttributes[];
  status?: OpenTelemetrySpanStatus;
  ended: boolean;
};

function createTracerCapture() {
  const spans: CapturedSpan[] = [];

  const tracer: OpenTelemetryTracer = {
    startSpan(
      name: string,
      options?: { attributes?: GuardTelemetryAttributes },
    ): OpenTelemetrySpan {
      const spanRecord: CapturedSpan = {
        name,
        startAttributes: options?.attributes,
        setAttributesCalls: [],
        ended: false,
      };

      spans.push(spanRecord);

      return {
        setAttributes(attributes: GuardTelemetryAttributes) {
          spanRecord.setAttributesCalls.push(attributes);
        },
        setStatus(status: OpenTelemetrySpanStatus) {
          spanRecord.status = status;
        },
        end() {
          spanRecord.ended = true;
        },
      };
    },
  };

  return {
    tracer,
    spans,
  };
}

function createLogCapture() {
  const logs: OpenTelemetryLogRecord[] = [];

  return {
    logEmitter: {
      emit(record: OpenTelemetryLogRecord) {
        logs.push(record);
      },
    },
    logs,
  };
}

test("createOpenTelemetryLogger emits one span and log for a successful run", async () => {
  const { tracer, spans } = createTracerCapture();
  const { logEmitter, logs } = createLogCapture();
  const logger = createOpenTelemetryLogger({
    tracer,
    logEmitter,
  });

  await guard.run(async () => ({ usage: { total_tokens: 21 } }), {
    name: "otel-success",
    userId: "user-1",
    provider: "openai",
    model: "gpt-4.1-mini",
    logger,
  });

  expect(spans).toHaveLength(1);
  expect(logs).toHaveLength(1);

  const span = spans[0];
  const log = logs[0];
  const spanAttributes = span.setAttributesCalls[0] ?? {};
  const logAttributes = log.attributes ?? {};

  expect(span.ended).toBe(true);
  expect(span.status).toEqual({ code: OPEN_TELEMETRY_SPAN_STATUS_CODE.OK });
  expect(spanAttributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.schemaVersion]).toBe(
    GUARD_TELEMETRY_SCHEMA_VERSION,
  );
  expect(spanAttributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.status]).toBe("success");
  expect(spanAttributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.name]).toBe("otel-success");
  expect(logAttributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.provider]).toBe("openai");
  expect(logAttributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.model]).toBe("gpt-4.1-mini");
  expect(log.severityText).toBe("INFO");
  expect(log.severityNumber).toBe(9);
});

test("toGuardTelemetryAttributes omits missing optional values", () => {
  const attributes = toGuardTelemetryAttributes({
    runId: "run-1",
    calls: 1,
    retries: 0,
    durationMs: 10,
    status: "success",
  });

  expect(attributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.runId]).toBe("run-1");
  expect(attributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.status]).toBe("success");
  expect(attributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.name]).toBeUndefined();
  expect(attributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.provider]).toBeUndefined();
  expect(attributes[GUARD_TELEMETRY_ATTRIBUTE_KEYS.estimatedCostUsd]).toBeUndefined();
});

test("sampling honors 0 and 1 boundaries", async () => {
  {
    const { tracer, spans } = createTracerCapture();
    const { logEmitter, logs } = createLogCapture();
    const logger = createOpenTelemetryLogger({
      tracer,
      logEmitter,
      traceSampleRate: 0,
      logSampleRate: 1,
    });

    await guard.run(async () => "ok", { logger });

    expect(spans).toHaveLength(0);
    expect(logs).toHaveLength(1);
  }

  {
    const { tracer, spans } = createTracerCapture();
    const { logEmitter, logs } = createLogCapture();
    const logger = createOpenTelemetryLogger({
      tracer,
      logEmitter,
      traceSampleRate: 1,
      logSampleRate: 0,
    });

    await guard.run(async () => "ok", { logger });

    expect(spans).toHaveLength(1);
    expect(logs).toHaveLength(0);
  }
});

test("invalid sample rates are rejected", () => {
  const { tracer } = createTracerCapture();

  expect(() => createOpenTelemetryLogger({ tracer, traceSampleRate: -0.1 })).toThrow(
    /traceSampleRate/,
  );
  expect(() => createOpenTelemetryLogger({ tracer, logSampleRate: 1.1 })).toThrow(/logSampleRate/);
  expect(() => createOpenTelemetryLogger({ tracer, traceSampleRate: Number.NaN })).toThrow(
    /traceSampleRate/,
  );
});

test("works across success, failed, blocked, and timeout statuses", async () => {
  const { tracer, spans } = createTracerCapture();
  const { logEmitter, logs } = createLogCapture();
  const logger = createOpenTelemetryLogger({ tracer, logEmitter });

  await guard.run(async () => "ok", {
    name: "status-success",
    logger,
  });

  await expect(
    guard.run(
      async () => {
        throw new Error("boom");
      },
      {
        name: "status-failed",
        logger,
        maxRetries: 0,
      },
    ),
  ).rejects.toThrow("boom");

  await expect(
    guard.run(async () => "never", {
      name: "status-blocked",
      logger,
      maxCalls: 0,
    }),
  ).rejects.toThrow(/Call limit reached/);

  await expect(
    guard.run(
      async () => {
        await sleep(20);
        return "slow";
      },
      {
        name: "status-timeout",
        logger,
        timeoutMs: 5,
        maxRetries: 0,
      },
    ),
  ).rejects.toThrow(/timeout/i);

  expect(spans).toHaveLength(4);
  expect(logs).toHaveLength(4);

  const statuses = logs.map((entry) => entry.attributes?.[GUARD_TELEMETRY_ATTRIBUTE_KEYS.status]);
  expect(statuses).toEqual(["success", "failed", "blocked", "timeout"]);
});

test("dry-run metadata is included when present", async () => {
  const { logEmitter, logs } = createLogCapture();
  const logger = createOpenTelemetryLogger({
    logEmitter,
  });

  await guard.run(async () => "ok", {
    mode: "dry-run",
    maxCalls: 0,
    logger,
  });

  expect(logs).toHaveLength(1);
  expect(logs[0].attributes?.[GUARD_TELEMETRY_ATTRIBUTE_KEYS.wouldBlock]).toBe(true);
  expect(logs[0].attributes?.[GUARD_TELEMETRY_ATTRIBUTE_KEYS.wouldBlockReasons]).toEqual([
    "CALL_LIMIT_EXCEEDED",
  ]);
});

test("logger propagation behavior matches GuardLogger contract", async () => {
  const loggerWithThrowingLogEmitter = createOpenTelemetryLogger({
    logEmitter: {
      emit() {
        throw new Error("otel-emit-failed");
      },
    },
  });

  await expect(
    guard.run(async () => "ok", { logger: loggerWithThrowingLogEmitter }),
  ).resolves.toMatchObject({
    data: "ok",
    usage: {
      status: "success",
    },
  });
});

test("high-volume logging overhead is bounded compared to memory logger baseline", () => {
  const iterations = 10_000;
  const usage = {
    runId: "run-load",
    name: "load-test",
    userId: "user-1",
    provider: "openai",
    model: "gpt-4.1-mini",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.0002,
    calls: 1,
    retries: 0,
    durationMs: 10,
    status: "success" as const,
  };

  const memoryLogger = createMemoryLogger();
  const { tracer } = createTracerCapture();
  const { logEmitter } = createLogCapture();
  const otelLogger = createOpenTelemetryLogger({ tracer, logEmitter });

  const baselineStart = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    void memoryLogger.log(usage);
  }

  const baselineMs = performance.now() - baselineStart;

  const otelStart = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    void otelLogger.log(usage);
  }

  const otelMs = performance.now() - otelStart;
  const maxAllowedMs = baselineMs * 25 + 200;

  expect(otelMs).toBeLessThanOrEqual(maxAllowedMs);
});
