import { Logger, Module } from "@nestjs/common";
import { AGENT_RUNNER } from "./agent-runner";
import { FakeRunner } from "./fake-runner";
import { HermesCliRunner } from "./hermes-cli-runner";

/**
 * Provides the active AgentRunner. `RUNNER=hermes` uses the real one-shot CLI
 * runner; anything else (default) uses the FakeRunner so tests and demos run
 * with no key and no cost.
 */
@Module({
  providers: [
    FakeRunner,
    HermesCliRunner,
    {
      provide: AGENT_RUNNER,
      inject: [FakeRunner, HermesCliRunner],
      useFactory: (fake: FakeRunner, hermes: HermesCliRunner) => {
        const choice = (process.env.RUNNER ?? "fake").toLowerCase();
        const runner = choice === "hermes" ? hermes : fake;
        new Logger("RunnerModule").log(`AGENT_RUNNER = ${runner.kind}`);
        return runner;
      },
    },
  ],
  exports: [AGENT_RUNNER],
})
export class RunnerModule {}
