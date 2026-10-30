import { describe, expect, it } from "vitest";
import { AgentConfigSpec, configHash, TaskSpec } from "@agent-evals/shared";
import { FakeRunner } from "../src/runner/fake-runner";

const taskSpec = TaskSpec.parse({
  slug: "reasoning-mult",
  prompt: "What is 7 times 6? Reply with only the number.",
  graders: [{ type: "regex", config: { pattern: "\\b42\\b" } }],
});
const configSpec = AgentConfigSpec.parse({ model: "gemini-3.8-flash" });

describe("configHash", () => {
  it("is stable regardless of key order", () => {
    const a = configHash(AgentConfigSpec.parse({ model: "m", provider: "gemini" }));
    const b = configHash(AgentConfigSpec.parse({ provider: "gemini", model: "m" }));
    expect(a).toBe(b);
  });

  it("changes when a knob changes", () => {
    const a = configHash(AgentConfigSpec.parse({ model: "a" }));
    const b = configHash(AgentConfigSpec.parse({ model: "b" }));
    expect(a).not.toBe(b);
  });
});

describe("FakeRunner", () => {
  it("replays a trajectory with the prompt as the first step", async () => {
    const result = await new FakeRunner().run({
      trialId: "t1",
      taskSpec,
      configSpec,
    });
    expect(result.error).toBeNull();
    expect(result.steps[0]).toMatchObject({ role: "user", content: taskSpec.prompt });
    expect(result.steps.at(-1)?.role).toBe("assistant");
    expect(result.finalAnswer.length).toBeGreaterThan(0);
    expect(result.usage.model).toBe("gemini-3.8-flash");
  });

  // Config-aware lookup: reads from apps/api/fixtures/recordings (vitest cwd).
  // flash-lite has a config-specific recording for reason-ages (the wrong answer
  // 24); flash has none, so it falls back to the per-task default (36).
  const reasonAges = TaskSpec.parse({
    slug: "reason-ages",
    prompt: "Maria is 3 times as old as her son… ANSWER: <number>",
    graders: [{ type: "regex", config: { pattern: "answer:\\s*36\\b" } }],
  });

  it("uses a config-specific recording when one exists (weak config fails)", async () => {
    const result = await new FakeRunner().run({
      trialId: "t2",
      taskSpec: reasonAges,
      configSpec,
      configName: "flash-lite",
    });
    expect(result.finalAnswer).toMatch(/answer:\s*24/i);
    expect(result.finalAnswer).not.toMatch(/answer:\s*36/i);
  });

  it("falls back to the per-task default when no config recording exists", async () => {
    const result = await new FakeRunner().run({
      trialId: "t3",
      taskSpec: reasonAges,
      configSpec,
      configName: "flash", // no flash/ folder → per-task default (36)
    });
    expect(result.finalAnswer).toMatch(/answer:\s*36\b/i);
  });
});
