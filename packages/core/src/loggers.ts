import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { GuardLogger, GuardUsage } from "./types.js";

export type MemoryLogger = GuardLogger & {
  getLogs: () => GuardUsage[];
  clear: () => void;
};

export type JsonFileLoggerOptions = {
  filePath: string;
  mkdir?: boolean;
  serialize?: (usage: GuardUsage) => string;
};

export function createConsoleLogger(): GuardLogger {
  return {
    log(usage: GuardUsage) {
      console.info("[guard-sdk]", usage);
    },
  };
}

export function createMemoryLogger(initial: GuardUsage[] = []): MemoryLogger {
  const logs = [...initial];

  return {
    log(usage: GuardUsage) {
      logs.push({ ...usage });
    },
    getLogs() {
      return [...logs];
    },
    clear() {
      logs.length = 0;
    },
  };
}

export function createJsonFileLogger(options: JsonFileLoggerOptions): GuardLogger {
  const ensureDirectory = options.mkdir ?? true;
  const serialize =
    options.serialize ??
    ((usage: GuardUsage) => {
      return JSON.stringify(usage);
    });

  return {
    async log(usage: GuardUsage) {
      if (ensureDirectory) {
        await mkdir(dirname(options.filePath), { recursive: true });
      }

      const serialized = serialize({ ...usage }).replace(/\r?\n$/, "");
      await appendFile(options.filePath, `${serialized}\n`, "utf8");
    },
  };
}
