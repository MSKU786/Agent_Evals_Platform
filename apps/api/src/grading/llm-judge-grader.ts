import { Inject, Injectable, Optional } from "@nestjs/common";
import type { GradeOutcome } from "@agent-evals/shared";
import { primaryPrompt } from "../runner/agent-runner";
import type { GradeInput, Grader } from "./grader";
import { JUDGE, type Judge } from "./judge";

/**
 * Open-ended grader backed by a Judge. When no judge is configured it returns
 * an "ungraded" outcome (weight 0) that the GradingService excludes from the
 * trial's weighted mean — rather than silently scoring 0.
 */
@Injectable()
export class LlmJudgeGrader implements Grader {
  readonly type = "llm-judge" as const;

  constructor(@Optional() @Inject(JUDGE) private readonly judge: Judge | null) {}

  async grade({ graderSpec, taskSpec, runResult }: GradeInput): Promise<GradeOutcome> {
    if (!this.judge) {
      return {
        graderType: graderSpec.type,
        score: 0,
        passed: false,
        weight: 0, // excluded from the weighted mean
        reason: "ungraded: no judge configured (set JUDGE=stub or JUDGE=openai)",
        evidence: { ungraded: true },
      };
    }

    const cfg = graderSpec.config as { rubric?: string };
    const verdict = await this.judge.judge({
      question: primaryPrompt(taskSpec),
      rubric: cfg.rubric ?? "",
      answer: runResult.finalAnswer ?? "",
    });

    return {
      graderType: graderSpec.type,
      score: verdict.score,
      passed: verdict.score >= graderSpec.passThreshold,
      weight: graderSpec.weight,
      reason: `[${this.judge.name}] ${verdict.reason}`,
      evidence: { judge: this.judge.name, score: verdict.score },
    };
  }
}
