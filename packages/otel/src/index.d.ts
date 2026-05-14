import type { GuardLogger, GuardStatus, GuardUsage } from "@guard-sdk/core";
export declare const GUARD_TELEMETRY_SCHEMA_VERSION: "1.0";
export type GuardTelemetrySchemaVersion = typeof GUARD_TELEMETRY_SCHEMA_VERSION;
export declare const GUARD_TELEMETRY_ATTRIBUTE_KEYS: {
  readonly schemaVersion: "guard.schema_version";
  readonly runId: "guard.run_id";
  readonly name: "guard.name";
  readonly userId: "guard.user_id";
  readonly provider: "guard.provider";
  readonly model: "guard.model";
  readonly status: "guard.status";
  readonly blockedReason: "guard.blocked_reason";
  readonly calls: "guard.calls";
  readonly retries: "guard.retries";
  readonly durationMs: "guard.duration_ms";
  readonly inputTokens: "guard.input_tokens";
  readonly outputTokens: "guard.output_tokens";
  readonly totalTokens: "guard.total_tokens";
  readonly estimatedCostUsd: "guard.estimated_cost_usd";
  readonly wouldBlock: "guard.would_block";
  readonly wouldBlockReasons: "guard.would_block_reasons";
};
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
export declare const OPEN_TELEMETRY_SPAN_STATUS_CODE: {
  readonly UNSET: 0;
  readonly OK: 1;
  readonly ERROR: 2;
};
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
export declare function createOpenTelemetryLogger(config: OpenTelemetryLoggerConfig): GuardLogger;
export declare function toGuardTelemetryAttributes(usage: GuardUsage): GuardTelemetryAttributes;
export type { GuardStatus, GuardUsage };
