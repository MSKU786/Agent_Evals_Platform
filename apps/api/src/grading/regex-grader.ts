import { Injectable } from "@nestjs/common";
import type { GradeOutcome } from "@agent-evals/shared";
import { type GradeInput, type Grader, normalize } from "./grader";

/**
 * regex / exact grader. Matches `config.pattern` against the normalised final
 * answer (whitespace collapsed, lowercased). For `type: "exact"`, `config.expected`
 * is matched literally after the same normalisation.
 */
@Injectable()
export class RegexGrader implements Grader {
  readonly type = "regex" as const;

  async grade({ graderSpec, runResult }: GradeInput): Promise<GradeOutcome> {
    const answer = normalize(runResult.finalAnswer ?? "");
    const cfg = graderSpec.config as { pattern?: string; expected?: string; flags?: string };

    let pattern = cfg.pattern;
    if (!pattern && cfg.expected !== undefined) {
      pattern = escapeRegExp(normalize(cfg.expected));
    }
    if (!pattern) {
      return {
        graderType: graderSpec.type,
        score: 0,
        passed: false,
        weight: graderSpec.weight,
        reason: "regex grader misconfigured: no `pattern` or `expected`",
        evidence: null,
      };
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern, cfg.flags ?? "i");
    } catch (e) {
      return {
        graderType: graderSpec.type,
        score: 0,
        passed: false,
        weight: graderSpec.weight,
        reason: `invalid regex /${pattern}/: ${e instanceof Error ? e.message : e}`,
        evidence: { pattern },
      };
    }

    const m = re.exec(answer);
    const passed = m !== null;
    const shown = answer.length > 160 ? answer.slice(0, 157) + "…" : answer;
    return {
      graderType: graderSpec.type,
      score: passed ? 1 : 0,
      passed,
      weight: graderSpec.weight,
      reason: passed
        ? `matched /${pattern}/ → "${m![0]}" in the answer`
        : `pattern /${pattern}/ not found in answer "${shown}"`,
      evidence: { pattern, match: m?.[0] ?? null },
    };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
