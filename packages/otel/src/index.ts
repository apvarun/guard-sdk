import type { GuardLogger, GuardStatus, GuardUsage } from "@guard-sdk/core";

export const GUARD_TELEMETRY_SCHEMA_VERSION = "1.0" as const;

export type GuardTelemetrySchemaVersion = typeof GUARD_TELEMETRY_SCHEMA_VERSION;

export const GUARD_TELEMETRY_ATTRIBUTE_KEYS = {
  schemaVersion: "guard.schema_version",
  runId: "guard.run_id",
  name: "guard.name",
  userId: "guard.user_id",
  provider: "guard.provider",
  model: "guard.model",
  status: "guard.status",
  blockedReason: "guard.blocked_reason",
  calls: "guard.calls",
  retries: "guard.retries",
  durationMs: "guard.duration_ms",
  inputTokens: "guard.input_tokens",
  outputTokens: "guard.output_tokens",
  totalTokens: "guard.total_tokens",
  estimatedCostUsd: "guard.estimated_cost_usd",
  wouldBlock: "guard.would_block",
  wouldBlockReasons: "guard.would_block_reasons",
} as const;

export type GuardTelemetryAttributeKey =
  (typeof GUARD_TELEMETRY_ATTRIBUTE_KEYS)[keyof typeof GUARD_TELEMETRY_ATTRIBUTE_KEYS];

export type OpenTelemetryAttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

export type GuardTelemetryAttributes = Partial<
  Record<GuardTelemetryAttributeKey, OpenTelemetryAttributeValue>
>;

export const OPEN_TELEMETRY_SPAN_STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type OpenTelemetrySpanStatusCode =
  (typeof OPEN_TELEMETRY_SPAN_STATUS_CODE)[keyof typeof OPEN_TELEMETRY_SPAN_STATUS_CODE];

export type OpenTelemetrySpanStatus = {
  code: OpenTelemetrySpanStatusCode;
  message?: string;
};

export type OpenTelemetrySpan = {
  setAttributes: (attributes: GuardTelemetryAttributes) => void;
  setStatus: (status: OpenTelemetrySpanStatus) => void;
  end: () => void;
};

export type OpenTelemetryTracer = {
  startSpan: (
    name: string,
    options?: { attributes?: GuardTelemetryAttributes },
  ) => OpenTelemetrySpan;
};

export type OpenTelemetryLogRecord = {
  body: string;
  attributes?: GuardTelemetryAttributes;
  severityText?: string;
  severityNumber?: number;
};

export type OpenTelemetryLogEmitter = {
  emit: (record: OpenTelemetryLogRecord) => void;
};

export type OpenTelemetryLoggerConfig = {
  tracer?: OpenTelemetryTracer;
  logEmitter?: OpenTelemetryLogEmitter;
  spanName?: string;
  logBody?: string;
  traceSampleRate?: number;
  logSampleRate?: number;
  random?: () => number;
};

function validateSampleRate(sampleRate: number | undefined, field: string): number {
  if (sampleRate === undefined) {
    return 1;
  }

  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new Error(`Invalid ${field}: expected a finite number between 0 and 1.`);
  }

  return sampleRate;
}

function shouldSample(sampleRate: number, random: () => number): boolean {
  if (sampleRate === 0) {
    return false;
  }

  if (sampleRate === 1) {
    return true;
  }

  return random() < sampleRate;
}

function setOptionalAttribute<T>(
  attributes: GuardTelemetryAttributes,
  key: GuardTelemetryAttributeKey,
  value: T | undefined,
): void {
  if (value !== undefined) {
    attributes[key] = value as OpenTelemetryAttributeValue;
  }
}

function setOptionalArrayAttribute<T>(
  attributes: GuardTelemetryAttributes,
  key: GuardTelemetryAttributeKey,
  value: T[] | undefined,
): void {
  if (value && value.length > 0) {
    attributes[key] = value as OpenTelemetryAttributeValue;
  }
}

function buildTelemetryAttributes(usage: GuardUsage): GuardTelemetryAttributes {
  const attributes: GuardTelemetryAttributes = {
    [GUARD_TELEMETRY_ATTRIBUTE_KEYS.schemaVersion]: GUARD_TELEMETRY_SCHEMA_VERSION,
    [GUARD_TELEMETRY_ATTRIBUTE_KEYS.runId]: usage.runId,
    [GUARD_TELEMETRY_ATTRIBUTE_KEYS.status]: usage.status,
    [GUARD_TELEMETRY_ATTRIBUTE_KEYS.calls]: usage.calls,
    [GUARD_TELEMETRY_ATTRIBUTE_KEYS.retries]: usage.retries,
    [GUARD_TELEMETRY_ATTRIBUTE_KEYS.durationMs]: usage.durationMs,
  };

  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.name, usage.name);
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.userId, usage.userId);
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.provider, usage.provider);
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.model, usage.model);
  setOptionalAttribute(
    attributes,
    GUARD_TELEMETRY_ATTRIBUTE_KEYS.blockedReason,
    usage.blockedReason,
  );
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.inputTokens, usage.inputTokens);
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.outputTokens, usage.outputTokens);
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.totalTokens, usage.totalTokens);
  setOptionalAttribute(
    attributes,
    GUARD_TELEMETRY_ATTRIBUTE_KEYS.estimatedCostUsd,
    usage.estimatedCostUsd,
  );
  setOptionalAttribute(attributes, GUARD_TELEMETRY_ATTRIBUTE_KEYS.wouldBlock, usage.wouldBlock);
  setOptionalArrayAttribute(
    attributes,
    GUARD_TELEMETRY_ATTRIBUTE_KEYS.wouldBlockReasons,
    usage.wouldBlockReasons,
  );

  return attributes;
}

function spanStatusForRunStatus(status: GuardStatus): OpenTelemetrySpanStatus {
  if (status === "success") {
    return {
      code: OPEN_TELEMETRY_SPAN_STATUS_CODE.OK,
    };
  }

  return {
    code: OPEN_TELEMETRY_SPAN_STATUS_CODE.ERROR,
    message: status,
  };
}

function logSeverityForRunStatus(status: GuardStatus): {
  severityText: string;
  severityNumber: number;
} {
  if (status === "success") {
    return {
      severityText: "INFO",
      severityNumber: 9,
    };
  }

  if (status === "blocked") {
    return {
      severityText: "WARN",
      severityNumber: 13,
    };
  }

  return {
    severityText: "ERROR",
    severityNumber: 17,
  };
}

export function createOpenTelemetryLogger(config: OpenTelemetryLoggerConfig): GuardLogger {
  const traceSampleRate = validateSampleRate(config.traceSampleRate, "traceSampleRate");
  const logSampleRate = validateSampleRate(config.logSampleRate, "logSampleRate");

  if (!config.tracer && !config.logEmitter) {
    throw new Error("createOpenTelemetryLogger requires at least one of tracer or logEmitter.");
  }

  const random = config.random ?? Math.random;

  return {
    log(usage: GuardUsage) {
      const usageSnapshot = { ...usage };
      const attributes = buildTelemetryAttributes(usageSnapshot);

      if (config.tracer && shouldSample(traceSampleRate, random)) {
        const span = config.tracer.startSpan(config.spanName ?? "guard.run", {
          attributes,
        });

        span.setAttributes(attributes);
        span.setStatus(spanStatusForRunStatus(usageSnapshot.status));
        span.end();
      }

      if (config.logEmitter && shouldSample(logSampleRate, random)) {
        const severity = logSeverityForRunStatus(usageSnapshot.status);

        config.logEmitter.emit({
          body: config.logBody ?? "guard.run",
          attributes,
          severityText: severity.severityText,
          severityNumber: severity.severityNumber,
        });
      }
    },
  };
}

export function toGuardTelemetryAttributes(usage: GuardUsage): GuardTelemetryAttributes {
  return buildTelemetryAttributes(usage);
}
