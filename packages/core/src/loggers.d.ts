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
export declare function createConsoleLogger(): GuardLogger;
export declare function createMemoryLogger(initial?: GuardUsage[]): MemoryLogger;
export declare function createJsonFileLogger(options: JsonFileLoggerOptions): GuardLogger;
