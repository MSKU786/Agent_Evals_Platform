import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { GradeOutcome } from "@agent-evals/shared";
import type { GradeInput, Grader } from "./grader";

/**
 * Runs a check script in the trial's sandbox dir. Exit code 0 = pass (score 1),
 * non-zero = fail (score 0); the reason is the script's stdout (trimmed) plus
 * the exit code, so the trial viewer shows exactly why. The final answer is
 * exposed to the script as $FINAL_ANSWER and written to ./agent_answer.txt.
 *
 * `config.command` is the shell command (run via `sh -c`). An optional
 * `config.timeoutSec` bounds it.
 */
@Injectable()
export class ScriptGrader implements Grader {
  readonly type = "script" as const;

  async grade({ graderSpec, runResult, sandboxDir }: GradeInput): Promise<GradeOutcome> {
    const cfg = graderSpec.config as { command?: string; timeoutSec?: number };
    if (!cfg.command) {
      return outcome(graderSpec.weight, 0, false, "script grader misconfigured: no `command`", null);
    }

    const cwd = sandboxDir ?? mkdtempSync(join(tmpdir(), "grade-"));
    try {
      writeFileSync(join(cwd, "agent_answer.txt"), runResult.finalAnswer ?? "");
    } catch {
      // best effort
    }

    const { code, stdout, stderr } = await run(cfg.command, cwd, {
      ...process.env,
      FINAL_ANSWER: runResult.finalAnswer ?? "",
    }, (cfg.timeoutSec ?? 60) * 1000);

    const passed = code === 0;
    const tail = (stdout || stderr || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return outcome(
      graderSpec.weight,
      passed ? 1 : 0,
      passed,
      passed
        ? `check passed (exit 0)${tail ? `: ${tail}` : ""}`
        : `check failed (exit ${code})${tail ? `: ${tail}` : ""}`,
      { exitCode: code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) },
    );
  }
}

function outcome(
  weight: number,
  score: number,
  passed: boolean,
  reason: string,
  evidence: Record<string, unknown> | null,
): GradeOutcome {
  return { graderType: "script", score, passed, weight, reason, evidence };
}

function run(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
