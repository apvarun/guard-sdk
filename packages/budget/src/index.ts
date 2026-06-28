import type { BudgetCommitOptions, BudgetCommitResult, BudgetSnapshot } from "@guard-sdk/core";

const ZERO_SNAPSHOT: BudgetSnapshot = { costUsd: 0, totalTokens: 0, calls: 0 };

export type MemoryBudgetStore = {
  get: (key: string) => BudgetSnapshot;
  add: (key: string, delta: BudgetSnapshot) => void;
  commit: (key: string, delta: BudgetSnapshot, options?: BudgetCommitOptions) => BudgetCommitResult;
  /** Returns a copy of the current snapshot for a key. */
  peek: (key: string) => BudgetSnapshot;
  /** Removes a single key (or all keys when omitted). */
  reset: (key?: string) => void;
  /** All keys currently tracked. */
  keys: () => string[];
};

function addSnapshots(current: BudgetSnapshot, delta: BudgetSnapshot): BudgetSnapshot {
  return {
    costUsd: current.costUsd + (delta.costUsd ?? 0),
    totalTokens: current.totalTokens + (delta.totalTokens ?? 0),
    calls: current.calls + (delta.calls ?? 0),
  };
}

function exceeds(snapshot: BudgetSnapshot, limits: Partial<BudgetSnapshot> | undefined) {
  return (
    (limits?.costUsd !== undefined && snapshot.costUsd > limits.costUsd) ||
    (limits?.totalTokens !== undefined && snapshot.totalTokens > limits.totalTokens) ||
    (limits?.calls !== undefined && snapshot.calls > limits.calls)
  );
}

/**
 * An in-process BudgetStore. Spend accumulates per key for the lifetime
 * of the process; pair it with a persistent store (e.g. the SQLite budget
 * store) when budgets must survive restarts.
 */
export function createMemoryBudgetStore(): MemoryBudgetStore {
  const entries = new Map<string, BudgetSnapshot>();

  return {
    get(key: string) {
      return { ...(entries.get(key) ?? ZERO_SNAPSHOT) };
    },
    add(key: string, delta: BudgetSnapshot) {
      const current = entries.get(key) ?? { ...ZERO_SNAPSHOT };
      entries.set(key, addSnapshots(current, delta));
    },
    commit(key: string, delta: BudgetSnapshot, options?: BudgetCommitOptions) {
      const current = entries.get(key) ?? { ...ZERO_SNAPSHOT };
      const next = addSnapshots(current, delta);

      if (exceeds(next, options?.rejectIfExceeded)) {
        return {
          snapshot: { ...current },
          rejected: true,
        };
      }

      entries.set(key, next);

      return {
        snapshot: { ...next },
        rejected: false,
      };
    },
    peek(key: string) {
      return { ...(entries.get(key) ?? ZERO_SNAPSHOT) };
    },
    reset(key?: string) {
      if (key === undefined) {
        entries.clear();
        return;
      }

      entries.delete(key);
    },
    keys() {
      return [...entries.keys()];
    },
  };
}
