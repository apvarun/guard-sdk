import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import { guard } from "@guard-sdk/core";
import { createSQLiteLogger } from "@guard-sdk/storage-sqlite";
import { formatUsageReport, parseReportArgs, runCli } from "../src/index.ts";

type CaptureIo = {
  stdout: string[];
  stderr: string[];
};

function createCaptureIo() {
  const state: CaptureIo = {
    stdout: [],
    stderr: [],
  };

  return {
    io: {
      stdout: (line: string) => {
        state.stdout.push(line);
      },
      stderr: (line: string) => {
        state.stderr.push(line);
      },
    },
    state,
  };
}

test("parseReportArgs requires --db", () => {
  expect(() => parseReportArgs([])).toThrow(/Missing required --db/);
});

test("parseReportArgs validates date and status", () => {
  expect(() => parseReportArgs(["--db", "usage.db", "--from", "not-a-date"])).toThrow(
    /Invalid --from value/,
  );

  expect(() => parseReportArgs(["--db", "usage.db", "--status", "unknown"])).toThrow(
    /Invalid --status value/,
  );
});

test("parseReportArgs parses filters", () => {
  const parsed = parseReportArgs([
    "--db",
    "usage.db",
    "--from",
    "2026-05-10T12:00:00.000Z",
    "--to",
    "2026-05-11T12:00:00.000Z",
    "--name",
    "daily-report",
    "--status",
    "blocked",
  ]);

  expect(parsed.dbPath).toBe("usage.db");
  expect(parsed.filters.name).toBe("daily-report");
  expect(parsed.filters.status).toBe("blocked");
  expect(parsed.filters.from).toBe("2026-05-10T12:00:00.000Z");
});

test("parseReportArgs supports --json", () => {
  const parsed = parseReportArgs(["--db", "usage.db", "--json"]);
  expect(parsed.json).toBe(true);
});

test("formatUsageReport renders deterministic output", () => {
  const output = formatUsageReport({
    totalRuns: 3,
    totalCalls: 8,
    totalEstimatedCostUsd: 0.1234564,
    blockedCalls: 1,
    timeouts: 2,
    mostExpensiveRun: {
      runId: "run-2",
      name: "research-agent",
      estimatedCostUsd: 0.1004,
    },
  });

  expect(output).toBe(
    [
      "GUARD-SDK Usage Report",
      "",
      "Total runs: 3",
      "Total calls: 8",
      "Total estimated cost: $0.123456",
      "Blocked calls: 1",
      "Timeouts: 2",
      "Most expensive run: research-agent (run-2) $0.100400",
    ].join("\n"),
  );
});

test("runCli returns report for generated logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-cli-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await guard.run(async () => ({ usage: { total_tokens: 100 } }), {
      name: "run-alpha",
      logger,
      maxRetries: 0,
    });

    await expect(
      guard.run(
        async () => {
          throw new Error("fail");
        },
        {
          name: "run-beta",
          logger,
          maxRetries: 0,
        },
      ),
    ).rejects.toThrow("fail");

    const { io, state } = createCaptureIo();
    const code = await runCli(["report", "--db", dbPath], io);

    expect(code).toBe(0);
    expect(state.stderr).toHaveLength(0);
    expect(state.stdout[0]).toContain("GUARD-SDK Usage Report");
    expect(state.stdout[0]).toContain("Total runs: 2");
    expect(state.stdout[0]).toContain("Total calls: 2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runCli supports status filter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-cli-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await guard.run(async () => "ok", {
      name: "success-run",
      logger,
    });

    await expect(
      guard.run(async () => "blocked", {
        name: "blocked-run",
        logger,
        maxCalls: 0,
      }),
    ).rejects.toThrow();

    const { io, state } = createCaptureIo();
    const code = await runCli(["report", "--db", dbPath, "--status", "blocked"], io);

    expect(code).toBe(0);
    expect(state.stdout[0]).toContain("Total runs: 1");
    expect(state.stdout[0]).toContain("Blocked calls: 1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runCli outputs single JSON summary object with --json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guard-sdk-cli-"));
  const dbPath = join(directory, "usage.db");

  try {
    const logger = await createSQLiteLogger({ dbPath });

    await guard.run(async () => ({ usage: { total_tokens: 20 } }), {
      name: "json-success-run",
      logger,
      maxRetries: 0,
    });

    await expect(
      guard.run(async () => "blocked", {
        name: "json-blocked-run",
        logger,
        maxCalls: 0,
      }),
    ).rejects.toThrow();

    const { io, state } = createCaptureIo();
    const code = await runCli(["report", "--db", dbPath, "--status", "blocked", "--json"], io);

    expect(code).toBe(0);
    expect(state.stderr).toHaveLength(0);
    expect(state.stdout).toHaveLength(1);

    const summary = JSON.parse(state.stdout[0]) as {
      totalRuns: number;
      blockedCalls: number;
      totalCalls: number;
    };

    expect(summary.totalRuns).toBe(1);
    expect(summary.blockedCalls).toBe(1);
    expect(summary.totalCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runCli returns clear error for missing db/table", async () => {
  const { io, state } = createCaptureIo();
  const code = await runCli(["report", "--db", "./does-not-exist.db"], io);

  expect(code).toBe(1);
  expect(state.stderr[0]).toContain("guard report failed");
});
