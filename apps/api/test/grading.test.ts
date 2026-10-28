import { describe, expect, it } from "vitest";
import { GraderSpec, TaskSpec } from "@agent-evals/shared";
import { RegexGrader } from "../src/grading/regex-grader";
import { ScriptGrader } from "../src/grading/script-grader";
import { LlmJudgeGrader } from "../src/grading/llm-judge-grader";
import {
  OpenAiCompatibleJudge,
  StubJudge,
  extractVerdict,
} from "../src/grading/judge";
import { combine } from "../src/grading/grading.service";

const taskSpec = TaskSpec.parse({
  slug: "t",
  prompt: "What is the capital of France?",
  graders: [{ type: "regex", config: {} }],
});
const run = (finalAnswer: string) => ({ finalAnswer, steps: [] });

describe("RegexGrader", () => {
  it("passes when the pattern matches (normalised)", async () => {
    const o = await new RegexGrader().grade({
      graderSpec: GraderSpec.parse({ type: "regex", config: { pattern: "\\b42\\b" } }),
      taskSpec,
      runResult: run("The answer is 42."),
    });
    expect(o.passed).toBe(true);
    expect(o.score).toBe(1);
    expect(o.reason).toMatch(/matched/);
  });

  it("fails and explains when the pattern is absent", async () => {
    const o = await new RegexGrader().grade({
      graderSpec: GraderSpec.parse({ type: "regex", config: { pattern: "\\b42\\b" } }),
      taskSpec,
      runResult: run("forty-two"),
    });
    expect(o.passed).toBe(false);
    expect(o.reason).toMatch(/not found/);
  });
});

describe("ScriptGrader", () => {
  it("passes on exit 0 and fails with the exit code on non-zero", async () => {
    const pass = await new ScriptGrader().grade({
      graderSpec: GraderSpec.parse({ type: "script", config: { command: "echo done; exit 0" } }),
      taskSpec,
      runResult: run("x"),
    });
    expect(pass.passed).toBe(true);
    expect(pass.reason).toMatch(/exit 0/);

    const fail = await new ScriptGrader().grade({
      graderSpec: GraderSpec.parse({ type: "script", config: { command: "echo nope; exit 3" } }),
      taskSpec,
      runResult: run("x"),
    });
    expect(fail.passed).toBe(false);
    expect(fail.reason).toMatch(/exit 3/);
  });
});

describe("extractVerdict", () => {
  it("parses plain and fenced JSON", () => {
    expect(extractVerdict('{"score":0.8,"reason":"good"}')).toEqual({ score: 0.8, reason: "good" });
    expect(extractVerdict('```json\n{"score":1,"reason":"ok"}\n```')?.score).toBe(1);
  });
  it("returns null for non-JSON", () => {
    expect(extractVerdict("I think it's fine")).toBeNull();
  });
});

describe("OpenAiCompatibleJudge", () => {
  it("retries once when the first reply is not JSON", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      const content = calls === 1 ? "not json at all" : '{"score":0.8,"reason":"good"}';
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
    }) as unknown as typeof fetch;

    const judge = new OpenAiCompatibleJudge(
      { baseUrl: "http://judge", apiKey: "k", model: "m" },
      fakeFetch,
      2,
    );
    const v = await judge.judge({ question: "q", rubric: "r", answer: "a" });
    expect(calls).toBe(2);
    expect(v.score).toBe(0.8);
  });
});

describe("LlmJudgeGrader", () => {
  it("is ungraded (weight 0) when no judge is configured", async () => {
    const o = await new LlmJudgeGrader(null).grade({
      graderSpec: GraderSpec.parse({ type: "llm-judge", config: { rubric: "mentions paris" } }),
      taskSpec,
      runResult: run("Paris"),
    });
    expect(o.weight).toBe(0);
    expect(o.reason).toMatch(/ungraded/);
  });

  it("scores via the StubJudge when configured", async () => {
    const o = await new LlmJudgeGrader(new StubJudge()).grade({
      graderSpec: GraderSpec.parse({ type: "llm-judge", config: { rubric: "paris capital" } }),
      taskSpec,
      runResult: run("Paris is the capital of France"),
    });
    expect(o.score).toBeGreaterThan(0);
    expect(o.reason).toMatch(/StubJudge/);
  });
});

describe("combine", () => {
  it("is the weighted mean, excluding ungraded (weight 0)", () => {
    const g = combine([
      { graderType: "regex", score: 1, passed: true, weight: 1, reason: "r", evidence: null },
      { graderType: "script", score: 0, passed: false, weight: 1, reason: "r", evidence: null },
      { graderType: "llm-judge", score: 0, passed: false, weight: 0, reason: "ungraded", evidence: null },
    ]);
    expect(g.score).toBe(0.5);
    expect(g.passed).toBe(true); // >= 0.5
  });
});
