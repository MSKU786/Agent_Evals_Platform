import type { AgentConfigSpec, RunResult, TaskSpec } from "@agent-evals/shared";

/** DI token for the active AgentRunner implementation. */
export const AGENT_RUNNER = Symbol("AGENT_RUNNER");

export interface RunInput {
  trialId: string;
  taskSpec: TaskSpec;
  configSpec: AgentConfigSpec;
  /** The config's human name (e.g. "flash", "flash-lite"). The FakeRunner uses
   * it to pick a config-specific recording so a weaker config can model a real
   * capability gap; the real runner ignores it. */
  configName?: string;
  /** Host directory to use as the trial sandbox / fixtures source, if any. */
  workdir?: string;
}

/**
 * One isolated agent run. Implementations: HermesCliRunner (real, one-shot
 * `hermes chat -q` in a throwaway Docker volume) and FakeRunner (replays a
 * recorded trajectory — no key, no cost, deterministic).
 */
export interface AgentRunner {
  readonly kind: "hermes" | "fake";
  run(input: RunInput): Promise<RunResult>;
}

/** The prompt a single-session task sends (sessions[] handled by the runner). */
export function primaryPrompt(task: TaskSpec): string {
  if (task.prompt) return task.prompt;
  const evalSession = task.sessions?.find((s) => s.role === "eval");
  return evalSession?.prompt ?? task.sessions?.[0]?.prompt ?? "";
}
