/**
 * Creates a temporary directory for testing and returns a cleanup function
 * @param prefix - Prefix for the temporary directory name
 * @returns Tuple of [directoryPath, cleanupFunction]
 */
export declare function createTempDir(prefix: string): Promise<[string, () => Promise<void>]>;
/**
 * Creates a temporary directory with a database path for SQLite logging tests
 * @param prefix - Prefix for the temporary directory name
 * @returns Tuple of [dbPath, cleanupFunction]
 */
export declare function createTempDbPath(prefix: string): Promise<[string, () => Promise<void>]>;
