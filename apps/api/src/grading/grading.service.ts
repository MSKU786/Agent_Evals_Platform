import { Injectable, Logger } from "@nestjs/common";
import {
  type GradeOutcome,
  RunResult,
  TaskSpec,
  type TrialGrade,
} from "@agent-evals/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { Grader } from "./grader";
import { RegexGrader } from "./regex-grader";
import { ScriptGrader } from "./script-grader";
import { LlmJudgeGrader } from "./llm-judge-grader";

/** Trial is "passed" when its weighted grade is at or above this. */
const TRIAL_PASS_THRESHOLD = 0.5;

@Injectable()
export class GradingService {
  private readonly logger = new Logger(GradingService.name);
  private readonly graders: Record<string, Grader>;

  constructor(
    private readonly prisma: PrismaService,
    regex: RegexGrader,
    script: ScriptGrader,
    llmJudge: LlmJudgeGrader,
  ) {
    this.graders = {
      regex,
      exact: regex, // RegexGrader handles `config.expected`
      script,
      "llm-judge": llmJudge,
    };
  }

  /** Grade (or re-grade) a trial from its stored final answer — no agent re-run. */
  async gradeTrial(trialId: string): Promise<TrialGrade> {
    const trial = await this.prisma.trial.findUniqueOrThrow({
      where: { id: trialId },
      include: { task: true },
    });
    const taskSpec = TaskSpec.parse(trial.task.spec);
    const runResult: Pick<RunResult, "finalAnswer" | "steps"> = {
      finalAnswer: trial.finalAnswer ?? "",
      steps: ((trial.trajectory as { steps?: unknown[] } | null)?.steps ?? []) as RunResult["steps"],
    };

    const outcomes: GradeOutcome[] = [];
    for (const graderSpec of taskSpec.graders) {
      const grader = this.graders[graderSpec.type];
      if (!grader) {
        outcomes.push({
          graderType: graderSpec.type,
          score: 0,
          passed: false,
          weight: 0,
          reason: `no grader registered for type "${graderSpec.type}"`,
          evidence: { unsupported: true },
        });
        continue;
      }
      outcomes.push(await grader.grade({ graderSpec, taskSpec, runResult }));
    }

    const grade = combine(outcomes);

    await this.prisma.$transaction([
      this.prisma.gradeResult.deleteMany({ where: { trialId } }),
      this.prisma.gradeResult.createMany({
        data: outcomes.map((o) => ({
          trialId,
          graderType: o.graderType,
          score: o.score,
          passed: o.passed,
          reason: o.reason,
          evidence: (o.evidence ?? undefined) as object | undefined,
        })),
      }),
      this.prisma.trial.update({
        where: { id: trialId },
        data: { score: grade.score, passed: grade.passed },
      }),
    ]);

    this.logger.log(
      `graded trial ${trialId}: score=${grade.score?.toFixed(2) ?? "n/a"} passed=${grade.passed}`,
    );
    return grade;
  }
}

/** Weighted mean of graded outcomes (weight 0 = ungraded, excluded). */
export function combine(outcomes: GradeOutcome[]): TrialGrade {
  const graded = outcomes.filter((o) => o.weight > 0);
  const totalWeight = graded.reduce((s, o) => s + o.weight, 0);
  if (totalWeight === 0) {
    return { score: 0, passed: false, graders: outcomes };
  }
  const score = graded.reduce((s, o) => s + o.score * o.weight, 0) / totalWeight;
  return { score, passed: score >= TRIAL_PASS_THRESHOLD, graders: outcomes };
}
