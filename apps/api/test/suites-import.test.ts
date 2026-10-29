import { describe, expect, it, vi } from "vitest";
import { SuitesService } from "../src/suites/suites.service";

/**
 * Re-importing a suite must be non-destructive: tasks are upserted by
 * (suite, slug) so existing task rows — and the trials that reference them —
 * survive. The old code blanket-deleted the suite's tasks, which threw
 * trials_task_id_fkey as soon as any task had trials.
 */

const suiteSpec = {
  name: "core",
  version: "1",
  tasks: [
    { slug: "a", prompt: "p", graders: [{ type: "regex", config: { pattern: "x" } }] },
    { slug: "b", prompt: "p", graders: [{ type: "regex", config: { pattern: "y" } }] },
  ],
};

function makeTx() {
  return {
    taskSuite: {
      upsert: vi.fn().mockResolvedValue({ id: "suite1", name: "core", version: "1" }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "suite1", tasks: [] }),
    },
    task: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeService(tx: ReturnType<typeof makeTx>) {
  const prisma = { $transaction: (fn: (tx: unknown) => unknown) => fn(tx) };
  return new SuitesService(prisma as never);
}

describe("SuitesService.import (non-destructive re-import)", () => {
  it("upserts tasks by (suite, slug) and never blanket-deletes the suite's tasks", async () => {
    const tx = makeTx();
    await makeService(tx).import(suiteSpec);

    expect(tx.task.upsert).toHaveBeenCalledTimes(2);
    // Regression guard: the FK-violating path was deleteMany({ where: { suiteId } }).
    for (const call of tx.task.deleteMany.mock.calls) {
      expect(call[0]?.where ?? {}).not.toHaveProperty("suiteId");
    }
  });

  it("keeps a removed task that still has trials; deletes only trial-free removals", async () => {
    const tx = makeTx();
    tx.task.findMany.mockResolvedValue([
      { id: "old-with-trials", _count: { trials: 3 } },
      { id: "old-empty", _count: { trials: 0 } },
    ]);

    await makeService(tx).import(suiteSpec);

    expect(tx.task.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.task.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old-empty"] } } });
  });
});
