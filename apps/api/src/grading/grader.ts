import type {
  GradeOutcome,
  GraderSpec,
  RunResult,
  TaskSpec,
} from "@agent-evals/shared";

export interface GradeInput {
  graderSpec: GraderSpec;
  taskSpec: TaskSpec;
  runResult: Pick<RunResult, "finalAnswer" | "steps">;
  /** The trial's sandbox dir (for script/file-state graders), if available. */
  sandboxDir?: string;
}

/**
 * One scoring rule. Every grader MUST return a human-readable `reason` that
 * explains the verdict — that string is what the trial viewer shows.
 */
export interface Grader {
  readonly type: GraderSpec["type"];
  grade(input: GradeInput): Promise<GradeOutcome>;
}

/** Collapse whitespace and lowercase — shared by the text graders. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
