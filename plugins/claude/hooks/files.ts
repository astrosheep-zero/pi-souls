import type { EngineInterface, PluginOptions } from "claude-code";

const RUNNER = `${import.meta.dir}/souls-runner.cjs`;
export type Engine = Pick<EngineInterface, "env" | "session" | "ui" | "clock" | "process" | "prompt" | "command">;
export interface SoulContent { dir: string; body: string; icon?: string }

/** One bundled Node entry; only JSON crosses the sandbox boundary. */
export async function files<T>($: Pick<Engine, "process" | "session">, options: PluginOptions, task: Record<string, unknown>): Promise<T> {
  const { exitCode, stdout, isStdoutTruncated } = await $.process.run(
    ["node", RUNNER, JSON.stringify({ ...task, soulsDir: options.soulsDir, cwd: await $.session.cwd() })], { timeoutMs: 10_000 },
  );
  if (isStdoutTruncated) throw new Error("Soul helper output was truncated");
  const result = JSON.parse(stdout);
  if (exitCode !== 0) throw new Error(typeof result.error === "string" ? result.error : "Soul helper failed");
  return result as T;
}
export function load($: Engine, options: PluginOptions, name: string, model: string): Promise<SoulContent> {
  return files<SoulContent>($, options, { op: "read", name, model: { provider: "", id: model } });
}
