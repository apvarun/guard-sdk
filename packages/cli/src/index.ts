import {
  readUsageReport,
  type UsageReportFilters,
  type UsageReportSummary,
} from "@guard-sdk/storage-sqlite";
import type { GuardStatus } from "@guard-sdk/core";
import { pathToFileURL } from "node:url";

export const VALID_STATUSES = ["success", "failed", "blocked", "timeout"] as const;

type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type ReportCommandOptions = {
  dbPath: string;
  tableName?: string;
  filters: UsageReportFilters;
};

function isGuardStatus(value: string): value is GuardStatus {
  return VALID_STATUSES.includes(value as (typeof VALID_STATUSES)[number]);
}

function validateIsoDate(value: string, flag: string): string {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid ${flag} value: ${value}. Expected an ISO8601 timestamp.`);
  }

  return new Date(timestamp).toISOString();
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

export function parseReportArgs(args: string[]): ReportCommandOptions {
  const filters: UsageReportFilters = {};
  let dbPath: string | undefined;
  let tableName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    switch (arg) {
      case "--db": {
        dbPath = readFlagValue(args, index, "--db");
        index += 1;
        break;
      }

      case "--from": {
        const value = readFlagValue(args, index, "--from");
        filters.from = validateIsoDate(value, "--from");
        index += 1;
        break;
      }

      case "--to": {
        const value = readFlagValue(args, index, "--to");
        filters.to = validateIsoDate(value, "--to");
        index += 1;
        break;
      }

      case "--name": {
        filters.name = readFlagValue(args, index, "--name");
        index += 1;
        break;
      }

      case "--status": {
        const status = readFlagValue(args, index, "--status");

        if (!isGuardStatus(status)) {
          throw new Error(
            `Invalid --status value: ${status}. Expected one of ${VALID_STATUSES.join(", ")}.`,
          );
        }

        filters.status = status;
        index += 1;
        break;
      }

      case "--table": {
        tableName = readFlagValue(args, index, "--table");
        index += 1;
        break;
      }

      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!dbPath) {
    throw new Error("Missing required --db <path> argument.");
  }

  if (filters.from && filters.to && filters.from > filters.to) {
    throw new Error("Invalid date range: --from must be less than or equal to --to.");
  }

  return {
    dbPath,
    tableName,
    filters,
  };
}

export function formatUsageReport(summary: UsageReportSummary): string {
  const cost = summary.totalEstimatedCostUsd.toFixed(6);
  const expensiveRun = summary.mostExpensiveRun
    ? `${summary.mostExpensiveRun.name ?? "(unnamed)"} (${summary.mostExpensiveRun.runId}) $${summary.mostExpensiveRun.estimatedCostUsd.toFixed(6)}`
    : "n/a";

  return [
    "GUARD-SDK Usage Report",
    "",
    `Total runs: ${summary.totalRuns}`,
    `Total calls: ${summary.totalCalls}`,
    `Total estimated cost: $${cost}`,
    `Blocked calls: ${summary.blockedCalls}`,
    `Timeouts: ${summary.timeouts}`,
    `Most expensive run: ${expensiveRun}`,
  ].join("\n");
}

export const REPORT_USAGE = [
  "Usage:",
  "  guard report --db <path> [--from <ISO8601>] [--to <ISO8601>] [--name <runName>] [--status <success|failed|blocked|timeout>] [--table <tableName>]",
].join("\n");

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    io.stdout(REPORT_USAGE);
    return 0;
  }

  if (command !== "report") {
    io.stderr(`Unknown command: ${command}`);
    io.stderr(REPORT_USAGE);
    return 1;
  }

  try {
    const options = parseReportArgs(rest);
    const summary = readUsageReport({
      dbPath: options.dbPath,
      tableName: options.tableName,
      filters: options.filters,
    });

    io.stdout(formatUsageReport(summary));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    io.stderr(`guard report failed: ${message}`);
    return 1;
  }
}

const currentArgvPath = process.argv[1];
const isDirectExecution =
  typeof currentArgvPath === "string" && import.meta.url === pathToFileURL(currentArgvPath).href;

if (isDirectExecution) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
  });

  process.exitCode = exitCode;
}
