import type { EngineInterface, PluginOptions } from "claude-code";
import { files } from "./files.ts";
import type { Moment, Utterance, World } from "../../../src/perception.ts";

export type { Moment, Utterance, World };
type Engine = Pick<EngineInterface, "env" | "session" | "clock" | "process">;
const RUNNER = `${import.meta.dir}/perception-runner.mjs`;
const CATEGORIES: Record<string, "reading" | "running" | "writing"> = {
  read: "reading", Read: "reading", grep: "reading", Grep: "reading", glob: "reading", Glob: "reading", find: "reading",
  bash: "running", Bash: "running", codemode: "running",
  edit: "writing", Edit: "writing", MultiEdit: "writing", write: "writing", Write: "writing",
};

export function toolMoment(toolName: string, phase: "before" | "after", input: unknown, output?: unknown, ok?: boolean): Moment {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = args.file_path ?? args.path;
  const text = (value: unknown) => {
    if (value === undefined || value === null) return undefined;
    try {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      return raw ? raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw : undefined;
    } catch { return undefined; }
  };
  const inputText = text(input), outputText = text(output);
  return {
    kind: "tool", phase, category: Object.hasOwn(CATEGORIES, toolName) ? CATEGORIES[toolName]! : "other", toolName,
    ...(typeof path === "string" && path ? { filePath: path } : {}),
    ...(inputText ? { input: inputText } : {}), ...(outputText ? { output: outputText } : {}),
    ...(ok === undefined ? {} : { ok }),
  };
}

export async function worldFor($: Engine, name: string, absenceMs?: number, now?: number): Promise<World> {
  now ??= await $.clock.now();
  const home = await $.env.get("HOME") ?? await $.env.get("USERPROFILE") ?? "";
  const date = new Date(now), hour = date.getHours(), weekday = date.getDay();
  return {
    now, sessionId: await $.session.id(), cwd: await $.session.cwd(), storeDir: `${home}/.local/share/pi-souls/${name}`,
    facts: { hour, morning: hour >= 5 && hour < 12, afternoon: hour >= 12 && hour < 17, evening: hour >= 17 && hour < 22, night: hour < 5 || hour >= 22, weekday, weekend: weekday === 0 || weekday === 6 },
    ...(absenceMs !== undefined && Number.isFinite(absenceMs) && absenceMs >= 0 ? { absenceMs } : {}),
  };
}

/** A one-shot module is fresh on every call; reload clears entry discovery. */
export async function perceive($: Engine, options: PluginOptions, paths: Map<string, string | undefined>, name: string, moment: Moment, world: World): Promise<Utterance | undefined> {
  try {
    if (!paths.has(name)) paths.set(name, (await files<{ path?: string }>($, options, { op: "perception", name })).path);
    const path = paths.get(name);
    if (!path) return undefined;
    const { exitCode, stdout, isStdoutTruncated } = await $.process.run(
      ["node", "--experimental-strip-types", RUNNER, path, JSON.stringify({ moment, world })], { timeoutMs: 10_000 },
    );
    if (exitCode !== 0 || isStdoutTruncated) return undefined;
    const line = stdout.trim().split("\n").pop();
    const said = line ? JSON.parse(line) : undefined;
    return said && typeof said.text === "string" && said.text.trim() ? { text: said.text } : undefined;
  } catch { return undefined; }
}
