import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Injectable, Logger } from "@nestjs/common";
import {
  type RunResult,
  TrajectoryStep,
  type Usage,
} from "@agent-evals/shared";
import {
  AgentRunner,
  primaryPrompt,
  type RunInput,
} from "./agent-runner";

const exec = promisify(execFile);

const IMAGE = process.env.HERMES_IMAGE ?? "nousresearch/hermes-agent:v2026.9.24";
const REPO_ROOT = process.env.REPO_ROOT ?? join(process.cwd());
const INSPECTOR = join(REPO_ROOT, "spike", "inspect_statedb.py");
// Dirs searched for a preloaded skill named in the config.
const SKILL_DIRS = [join(REPO_ROOT, "skills"), join(REPO_ROOT, "spike", "skills")];

/**
 * Real runner: one isolated `hermes chat -q --oneshot` per trial in a throwaway
 * Docker volume, exactly as the Phase-0 spike validated (see
 * docs/hermes-findings.md). Memory is seeded into config.yaml; model, provider,
 * toolsets and skills are CLI flags. The trajectory is read back from the
 * trial's state.db via spike/inspect_statedb.py.
 */
@Injectable()
export class HermesCliRunner implements AgentRunner {
  readonly kind = "hermes" as const;
  private readonly logger = new Logger(HermesCliRunner.name);

  async run(input: RunInput): Promise<RunResult> {
    const started = Date.now();
    const vol = `trial_${input.trialId}_${Date.now()}`;
    const { configSpec, taskSpec } = input;
    const env = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };

    try {
      await this.docker(["volume", "create", vol], env);

      // Seed memory (config-only knob); /init writes config.yaml first.
      await this.docker(
        [
          "run", "--rm", "-e", "HERMES_UID=10000", "-e", "HERMES_GID=10000",
          "-v", `${vol}:/opt/data`, IMAGE,
          "config", "set", "memory.memory_enabled", String(configSpec.memoryEnabled),
        ],
        env,
      );

      // A task is one prompt, or an ordered setup→eval session list (memory
      // tasks). All sessions share the volume so memory carries across them.
      const sessions = taskSpec.sessions?.length
        ? taskSpec.sessions
        : [{ role: "eval" as const, prompt: primaryPrompt(taskSpec) }];
      for (const session of sessions) {
        await this.runChat(vol, session.prompt, configSpec, taskSpec, env);
      }

      const parsed = await this.inspect(vol, env);
      return {
        sessionId: parsed.sessionId ?? null,
        finalAnswer: parsed.finalAnswer ?? "",
        steps: (parsed.steps ?? []).map(mapStep),
        usage: mapUsage(parsed.tokens, configSpec.model),
        latencyMs: Date.now() - started,
        error: null,
      };
    } catch (err) {
      return {
        sessionId: null,
        finalAnswer: "",
        steps: [],
        usage: emptyUsage(configSpec.model),
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await this.docker(["volume", "rm", "-f", vol], env).catch(() => undefined);
    }
  }

  private async runChat(
    vol: string,
    prompt: string,
    cfg: RunInput["configSpec"],
    task: RunInput["taskSpec"],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const args = [
      "create",
      "-e", "GEMINI_API_KEY",
      "-e", "HERMES_UID=10000", "-e", "HERMES_GID=10000",
      "-v", `${vol}:/opt/data`,
      IMAGE,
      "chat", "-q", prompt, "--oneshot",
      "--provider", cfg.provider, "-m", cfg.model,
      "--yolo", "--max-turns", String(cfg.maxTurns),
      "--run-budget", String(task.timeoutSec),
    ];
    if (cfg.toolsets.length) args.push("-t", cfg.toolsets.join(","));
    if (cfg.skills.length) args.push("-s", cfg.skills.join(","));

    const { stdout } = await this.docker(args, env);
    const cid = stdout.trim().split("\n").pop()!.trim();
    try {
      for (const skill of cfg.skills) {
        const src = SKILL_DIRS.map((d) => join(d, skill)).find(existsSync);
        if (src) {
          await this.docker(["cp", src, `${cid}:/opt/data/skills/`], env).catch(
            () => undefined,
          );
        }
      }
      await this.docker(["start", "-a", cid], env);
    } finally {
      await this.docker(["rm", "-f", cid], env).catch(() => undefined);
    }
  }

  private async inspect(
    vol: string,
    env: NodeJS.ProcessEnv,
  ): Promise<InspectorOutput> {
    // Pipe the inspector script in on stdin (python3 - <db>), matching run-one.sh.
    const script = readFileSync(INSPECTOR);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "run", "--rm", "-i", "-v", `${vol}:/opt/data`,
          "--entrypoint", "python3", IMAGE,
          "-I", "-", "/opt/data/state.db",
        ],
        { env },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`inspector exit ${code}: ${err}`)),
      );
      child.stdin.write(script);
      child.stdin.end();
    });
    return JSON.parse(stdout);
  }

  private docker(args: string[], env: NodeJS.ProcessEnv) {
    return exec("docker", args, { env, maxBuffer: 64 * 1024 * 1024 });
  }
}

interface InspectorOutput {
  sessionId?: string;
  finalAnswer?: string;
  steps?: Array<Record<string, unknown>>;
  tokens?: Record<string, unknown>;
}

function mapStep(s: Record<string, unknown>) {
  return TrajectoryStep.parse({
    role: s.role,
    content: (s.content as string | null) ?? null,
    toolName: (s.tool_name as string | null) ?? null,
    toolCallId: (s.tool_call_id as string | null) ?? null,
    toolCalls: Array.isArray(s.tool_calls)
      ? (s.tool_calls as Array<Record<string, unknown>>).map((c) => ({
          id: (c.id as string) ?? undefined,
          name:
            ((c.function as Record<string, unknown>)?.name as string) ?? "",
          arguments:
            ((c.function as Record<string, unknown>)?.arguments as string) ??
            "",
        }))
      : null,
    tokenCount: (s.token_count as number | null) ?? null,
    finishReason: (s.finish_reason as string | null) ?? null,
  });
}

function mapUsage(t: Record<string, unknown> | undefined, model: string): Usage {
  const n = (k: string) => (typeof t?.[k] === "number" ? (t[k] as number) : 0);
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    reasoningTokens: n("reasoning_tokens"),
    cacheReadTokens: n("cache_read_tokens"),
    cacheWriteTokens: n("cache_write_tokens"),
    toolCallCount: n("tool_call_count"),
    costUsd:
      typeof t?.estimated_cost_usd === "number"
        ? (t.estimated_cost_usd as number)
        : null,
    model: (t?.model as string) ?? model,
  };
}

function emptyUsage(model: string): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCallCount: 0,
    costUsd: null,
    model,
  };
}
