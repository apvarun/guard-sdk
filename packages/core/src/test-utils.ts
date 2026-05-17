import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Creates a temporary directory for testing and returns a cleanup function
 * @param prefix - Prefix for the temporary directory name
 * @returns Tuple of [directoryPath, cleanupFunction]
 */
export async function createTempDir(prefix: string): Promise<[string, () => Promise<void>]> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  return [directory, cleanup];
}

/**
 * Creates a temporary directory with a database path for SQLite logging tests
 * @param prefix - Prefix for the temporary directory name
 * @returns Tuple of [dbPath, cleanupFunction]
 */
export async function createTempDbPath(prefix: string): Promise<[string, () => Promise<void>]> {
  const [directory, cleanup] = await createTempDir(prefix);
  const dbPath = join(directory, "usage.db");
  return [dbPath, cleanup];
}
