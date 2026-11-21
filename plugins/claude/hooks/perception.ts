import type { EngineInterface, PluginOptions } from "claude-code";
import { files } from "./files.ts";
import { runPerception, type PerceptionRuntime } from "./perception-runtime.ts";
import type { Moment, Utterance, World } from "../../../src/perception.ts";
import { utterances } from "../../../src/utterance.ts";

export type { Moment, Utterance, World };
type Engine = Pick<EngineInterface, "env" | "session" | "clock" | "process" | "http">;
const CATEGORIES: Record<string, "reading" | "running" | "writing"> = {
  read: "reading", Read: "reading", grep: "reading", Grep: "reading", glob: "reading", Glob: "reading", find: "reading",
  bash: "running", Bash: "running", codemode: "running",
  edit: "writing", Edit: "writing", MultiEdit: "writing", write: "writing", Write: "writing",
};

export function toolMoment(toolName: string, phase: "before" | "after", input: unknown, output?: unknown, ok?: boolean): Extract<Moment, { kind: "tool" }> {
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

export async function worldFor($: Engine, name: string, previousHumanAt?: number): Promise<World> {
  const now = await $.clock.now();
  const absenceMs = previousHumanAt === undefined ? undefined : Math.max(0, now - previousHumanAt);
  const home = await $.env.get("HOME") ?? await $.env.get("USERPROFILE") ?? "";
  const date = new Date(now), hour = date.getHours(), weekday = date.getDay();
  return {
    now, sessionId: await $.session.id(), cwd: await $.session.cwd(), storeDir: `${home}/.local/share/pi-souls/${name}`,
    facts: { hour, morning: hour >= 5 && hour < 12, afternoon: hour >= 12 && hour < 17, evening: hour >= 17 && hour < 22, night: hour < 5 || hour >= 22, weekday, weekend: weekday === 0 || weekday === 6 },
    ...(absenceMs !== undefined && Number.isFinite(absenceMs) && absenceMs >= 0 ? { absenceMs } : {}),
  };
}

/** Discover fresh, then reuse the shared loader's cached closure in the session child. */
export async function perceptionUtterances($: Engine, options: PluginOptions, runtime: PerceptionRuntime, generation: number, name: string, moment: Moment, world: World | Promise<World>, signal?: AbortSignal): Promise<readonly Utterance[]> {
  try {
    const facts = await world;
    if (generation !== runtime.generation || signal?.aborted) return [];
    const { path } = await files<{ path?: string }>($, options, { op: "perception", name });
    if (!path || generation !== runtime.generation || signal?.aborted) return [];
    const said = await runPerception($, runtime, { path, moment, world: facts }, signal);
    return generation === runtime.generation && !signal?.aborted ? utterances(said) : [];
  } catch { return []; }
}
