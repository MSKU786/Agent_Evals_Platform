import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { renderHermesConfig } from "./render-config";

const exec = promisify(execFile);

const IMAGE = process.env.HERMES_IMAGE ?? "nousresearch/hermes-agent:v2026.9.24";

/**
 * Repo root, found by walking up from this file until `spike/inspect_statedb.py`
 * is seen. `process.cwd()` is wrong here: the worker runs from `apps/api`, so the
 * inspector (at the repo root's `spike/`) would not be found.
 */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "spike", "inspect_statedb.py"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = process.env.REPO_ROOT ?? findRepoRoot();
const INSPECTOR = join(REPO_ROOT, "spike", "inspect_statedb.py");
// Dirs searched for a preloaded skill named in the config.
const SKILL_DIRS = [join(REPO_ROOT, "skills"), join(REPO_ROOT, "spike", "skills")];
// Writable sandbox the terminal tool runs in (its default cwd `/` is root-owned
// and read-only — see docs/hermes-findings.md). Seeded and chowned per trial.
const WORKDIR = "/opt/data/work";

// Which .env var holds each provider's key. Keeping it a plain map (not a
// provider framework) means switching the whole experiment to another provider
// is a one-line config/env change, not a code edit. See docs/DESIGN.md.
const PROVIDER_ENV: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** The env var Hermes reads for a config's provider; throws if unmapped. */
function providerKeyEnv(provider: string): string {
  const name = PROVIDER_ENV[provider.toLowerCase()];
  if (!name) {
    throw new Error(
      `No API-key env mapping for provider "${provider}" (add it to PROVIDER_ENV)`,
    );
  }
  return name;
}

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
      // Pick the key env for this config's provider; a missing key is a clear
      // failed trial, not a silent mid-run fallback (we hold one variable
      // constant across the experiment).
      const keyEnv = providerKeyEnv(configSpec.provider);
      if (!env[keyEnv]?.trim()) {
        throw new Error(
          `${keyEnv} is not set in .env (required for provider "${configSpec.provider}")`,
        );
      }

      await this.docker(["volume", "create", vol], env);

      // Seed config.yaml + skills into the volume WITHOUT booting a gateway.
      // Booting once to `config set` leaves stale gateway/lease state that makes
      // the next run's turn get rejected ("request not processed"), so the chat
      // below is the single gateway lifecycle on this volume.
      await this.seedVolume(vol, configSpec, env);

      // A task is one prompt, or an ordered setup→eval session list (memory
      // tasks). All sessions share the volume so memory carries across them.
      const sessions = taskSpec.sessions?.length
        ? taskSpec.sessions
        : [{ role: "eval" as const, prompt: primaryPrompt(taskSpec) }];
      let lastDiag = "";
      for (const session of sessions) {
        const { diagTail } = await this.runChat(
          vol, session.prompt, configSpec, taskSpec, env, keyEnv,
        );
        if (diagTail) lastDiag = diagTail;
      }

      const parsed = await this.inspect(vol, env);
      if (!parsed.sessionId) {
        throw new Error("hermes wrote no session to state.db (see worker logs)");
      }
      const finalAnswer = parsed.finalAnswer ?? "";
      const usage = mapUsage(parsed.tokens, configSpec.model);
      // Zero tokens means no model call actually happened — a provider refusal
      // (quota/credits/auth). Hermes still writes a session and a canned "request
      // not processed" answer, so answer text alone isn't enough; the token
      // count is. Surface what the provider said and FAIL the trial — never
      // silently switch provider (we hold one variable constant).
      if (usage.inputTokens === 0 && usage.outputTokens === 0) {
        throw new Error(
          `provider "${configSpec.provider}" made no model call (0 tokens) — ` +
            `refusal/quota/credits: ${lastDiag || "no provider message captured"}`,
        );
      }
      return {
        sessionId: parsed.sessionId ?? null,
        finalAnswer,
        steps: (parsed.steps ?? []).map(mapStep),
        usage,
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

  /**
   * One `hermes chat` session via `docker run --rm` (the pattern the Phase-0
   * spike proved reliable). A non-zero exit is TOLERATED: hermes can exit
   * non-zero (e.g. turn-lost = 3) while still writing a usable state.db, so we
   * judge success by what inspect() reads back, not the exit code.
   */
  private async runChat(
    vol: string,
    prompt: string,
    cfg: RunInput["configSpec"],
    task: RunInput["taskSpec"],
    env: NodeJS.ProcessEnv,
    keyEnv: string,
  ): Promise<{ diagTail: string }> {
    const args = [
      "run", "--rm",
      // Pass the provider's key by name only (value stays out of argv/logs).
      "-e", keyEnv,
      "-e", "HERMES_UID=10000", "-e", "HERMES_GID=10000",
      "-v", `${vol}:/opt/data`,
      "-w", WORKDIR,
      IMAGE,
      "chat", "-q", prompt, "--oneshot",
      "--provider", cfg.provider, "-m", cfg.model,
      "--yolo", "--max-turns", String(cfg.maxTurns),
      "--run-budget", String(task.timeoutSec),
    ];
    if (cfg.toolsets.length) args.push("-t", cfg.toolsets.join(","));
    if (cfg.skills.length) args.push("-s", cfg.skills.join(","));

    const { code, stdout, stderr } = await this.dockerRun(args, env);
    // Hermes prints provider errors (e.g. "HTTP 402 … credits … exhausted") to
    // stdout, s6 noise to stderr. Pull the most telling line from both.
    const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
    const errLine = lines
      .filter((l) => /\b([45]\d\d|error|exhaust|credit|billing|reject|unauthor|quota|rate limit|not processed)\b/i.test(l))
      .pop();
    const diagTail = (errLine ?? lines.at(-1) ?? "").slice(0, 500);
    if (code !== 0) {
      this.logger.warn(`hermes chat exited ${code} (tolerated; parsing state.db). ${diagTail}`);
    }
    return { diagTail };
  }

  /**
   * Seed the volume with config.yaml (carrying the memory setting) and any
   * preloaded skills, via a plain file copy that does NOT boot /init or the
   * gateway. This keeps the subsequent chat as the single gateway lifecycle.
   */
  private async seedVolume(
    vol: string,
    cfg: RunInput["configSpec"],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const seedDir = mkdtempSync(join(tmpdir(), "hermes-seed-"));
    writeFileSync(join(seedDir, "config.yaml"), renderHermesConfig(cfg));

    // Docker Desktop wants forward-slash host paths (C:/foo), not backslashes.
    const toMount = (p: string) => p.replace(/\\/g, "/");
    const mounts = ["-v", `${toMount(seedDir)}:/seed:ro`];
    for (const skill of cfg.skills) {
      const src = SKILL_DIRS.map((d) => join(d, skill)).find(existsSync);
      if (src) mounts.push("-v", `${toMount(src)}:/skills_src/${skill}:ro`);
    }

    const { code, stderr } = await this.dockerRun(
      [
        "run", "--rm", "-v", `${vol}:/opt/data`, ...mounts,
        "--entrypoint", "sh", IMAGE,
        "-c",
        "cp /seed/config.yaml /opt/data/config.yaml && " +
          "mkdir -p /opt/data/work && " +
          // The chat runs as uid 10000; make the sandbox writable for it so the
          // terminal tool can create files (its default cwd `/` is read-only).
          "chown -R 10000:10000 /opt/data/work 2>/dev/null || true; " +
          "if [ -d /skills_src ]; then mkdir -p /opt/data/skills && cp -r /skills_src/* /opt/data/skills/ 2>/dev/null || true; fi",
      ],
      env,
    );
    if (code !== 0) {
      this.logger.warn(`volume seed exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
    }
  }

  /** Run docker, resolving with the exit code instead of throwing on non-zero. */
  private dockerRun(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("docker", args, { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
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
