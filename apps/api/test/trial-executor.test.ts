import { describe, expect, it, vi } from "vitest";
import { AgentConfigSpec, TaskSpec, type RunResult } from "@agent-evals/shared";
import { TrialExecutor } from "../src/trials/trial-executor";

/**
 * The idempotency guard: a duplicate pg-boss delivery of a trial that has
 * already finished must never re-run the agent or overwrite the stored result.
 * This is what stops a retry from flipping a passed trial to failed.
 */

const job = {
  experimentId: "exp1",
  taskId: "task1",
  configId: "cfg1",
  repIndex: 0,
};

const taskRow = {
  id: "task1",
  spec: TaskSpec.parse({
    slug: "reason-x",
    prompt: "What is 6 times 7? Reply with ANSWER: <n>.",
    graders: [{ type: "regex", config: { pattern: "answer:\\s*42\\b" } }],
  }),
};
const configRow = {
  id: "cfg1",
  name: "smoke",
  spec: AgentConfigSpec.parse({ model: "gemini-3.8-flash" }),
};

function makeExecutor(trialFindUnique: unknown) {
  const prisma = {
    trial: {
      findUnique: vi.fn().mockResolvedValue(trialFindUnique),
      upsert: vi.fn().mockResolvedValue({ id: "trial1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    task: { findUniqueOrThrow: vi.fn().mockResolvedValue(taskRow) },
    agentConfig: { findUniqueOrThrow: vi.fn().mockResolvedValue(configRow) },
  };
  const runResult: RunResult = {
    sessionId: "s1",
    finalAnswer: "ANSWER: 42",
    steps: [],
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCallCount: 0,
      costUsd: 0,
      model: "gemini-3.8-flash",
    },
    latencyMs: 1,
    error: null,
  };
  const runner = { kind: "fake" as const, run: vi.fn().mockResolvedValue(runResult) };
  const grading = { gradeTrial: vi.fn().mockResolvedValue(undefined) };
  // The @Inject tokens don't matter when we construct directly.
  const executor = new TrialExecutor(prisma as never, runner as never, grading as never);
  return { executor, prisma, runner, grading };
}

describe("TrialExecutor idempotency", () => {
  it("ignores a duplicate delivery of a completed trial (no re-run, no overwrite)", async () => {
    const { executor, prisma, runner } = makeExecutor({ status: "done" });

    await executor.execute(job);

    expect(runner.run).not.toHaveBeenCalled(); // agent not re-run
    expect(prisma.trial.upsert).not.toHaveBeenCalled(); // not flipped back to running
    expect(prisma.trial.update).not.toHaveBeenCalled(); // result not overwritten
  });

  it("still runs a trial that has no prior row (guard isn't overbroad)", async () => {
    const { executor, prisma, runner, grading } = makeExecutor(null);

    await executor.execute(job);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(prisma.trial.upsert).toHaveBeenCalledOnce();
    expect(prisma.trial.update).toHaveBeenCalled();
    expect(grading.gradeTrial).toHaveBeenCalledOnce();
  });

  it("re-runs a previously failed trial (infra retry still allowed)", async () => {
    const { executor, runner } = makeExecutor({ status: "failed" });

    await executor.execute(job);

    expect(runner.run).toHaveBeenCalledOnce();
  });
});
