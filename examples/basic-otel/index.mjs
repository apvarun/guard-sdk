import { guard } from "@guard-sdk/core";
import { createOpenTelemetryLogger } from "@guard-sdk/otel";

const tracer = {
  startSpan(name, options) {
    console.log("startSpan", name, options?.attributes);

    return {
      setAttributes(attributes) {
        console.log("span attributes", attributes);
      },
      setStatus(status) {
        console.log("span status", status);
      },
      end() {
        console.log("span end");
      },
    };
  },
};

const logEmitter = {
  emit(record) {
    console.log("log record", record);
  },
};

const logger = createOpenTelemetryLogger({ tracer, logEmitter });

await guard.run(async () => ({ usage: { total_tokens: 64 } }), {
  name: "otel-run",
  provider: "openai",
  model: "gpt-4.1-mini",
  logger,
});

const run = guard.createRun({
  name: "otel-agent-loop",
  logger,
});

await run.call("step-1", async () => ({ usage: { total_tokens: 20 } }));
await run.call("step-2", async () => ({ usage: { total_tokens: 15 } }));

console.log("summary", run.summary());
