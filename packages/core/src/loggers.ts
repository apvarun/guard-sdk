import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

function resolveSafeFilePath(pathValue: string, label: string): string {
  if (!pathValue || typeof pathValue !== "string") {
    throw new Error(`${label} must be a non-empty string.`);
  }

  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(pathValue);
  } catch {
    throw new Error(`${label} contains invalid URI encoding.`);
  }

  if (decodedPath.includes("\0")) {
    throw new Error(`${label} contains invalid null bytes.`);
  }

  if (isAbsolute(decodedPath)) {
    return resolve(decodedPath);
  }

  const normalizedForTraversal = decodedPath.replaceAll("\\", "/");

  if (normalizedForTraversal.split("/").includes("..")) {
    throw new Error(`${label} must not contain path traversal segments.`);
  }

  const resolvedPath = resolve(process.cwd(), decodedPath);
  const relativePath = relative(process.cwd(), resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} resolves outside the current working directory.`);
  }

  return resolvedPath;
}

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
  const filePath = resolveSafeFilePath(options.filePath, "filePath");
  const serialize =
    options.serialize ??
    ((usage: GuardUsage) => {
      return JSON.stringify(usage);
    });

  return {
    async log(usage: GuardUsage) {
      if (ensureDirectory) {
        await mkdir(dirname(filePath), { recursive: true });
      }

      const serialized = serialize({ ...usage }).replace(/\r?\n$/, "");
      await appendFile(filePath, `${serialized}\n`, "utf8");
    },
  };
}
