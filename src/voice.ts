import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VOICE_MESSAGE_TYPE = "pi-souls:voice";

/** How the host saw a tool call; a voice module reads this instead of parsing tool names. */
export type ToolCategory = "reading" | "running" | "writing" | "other";

/** One lifecycle beat a soul may answer. */
export type Moment =
  | { kind: "wake"; source: "startup" | "resume" | "compact" | "clear" | "fork" }
  | { kind: "human"; text: string }
  | {
      kind: "tool";
      phase: "before" | "after";
      category: ToolCategory;
      toolName: string;
      filePath?: string;
      input?: string;
      output?: string;
      ok?: boolean;
    }
  | { kind: "brain"; id: string; provider?: string }
  | { kind: "soul"; name: string };

/** Who reads an utterance; `model` is the default. */
export type Audience = "model" | "human" | "both";

export interface Utterance {
  text: string;
  audience?: Audience;
}

export interface World {
  now: number;
  sessionId: string;
  cwd: string;
  absenceMs?: number;
  storeDir: string;
  facts: {
    hour: number;
    morning: boolean;
    afternoon: boolean;
    evening: boolean;
    night: boolean;
    weekday: number;
    weekend: boolean;
    [key: string]: unknown;
  };
}

/** What a soul's `voice.ts` exports, by name or as the default. */
export type Voice = (moment: Moment, world: World) => Utterance | undefined | Promise<Utterance | undefined>;

const CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  read: "reading",
  Read: "reading",
  grep: "reading",
  Grep: "reading",
  glob: "reading",
  Glob: "reading",
  find: "reading",
  bash: "running",
  Bash: "running",
  codemode: "running",
  edit: "writing",
  Edit: "writing",
  MultiEdit: "writing",
  write: "writing",
  Write: "writing",
};

/** Long tool details are cut here; a voice module gets the shape, not the whole file. */
const DETAIL_LIMIT = 2000;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function toolCategory(toolName: string): ToolCategory {
  return Object.hasOwn(CATEGORIES, toolName) ? CATEGORIES[toolName]! : "other";
}

/** The path a tool call touches, from Pi's `path` or Claude's `file_path`. */
export function toolFilePath(input: unknown): string | undefined {
  if (!object(input)) return undefined;
  const path = input.path ?? input.file_path;
  return typeof path === "string" && path ? path : undefined;
}

/** A tool argument or result as bounded text: strings as they are, anything else as JSON. */
export function toolText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== "string") return undefined;
      text = json;
    } catch {
      return undefined;
    }
  }
  if (!text) return undefined;
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** Clock facts a voice module can branch on without re-reading the clock. */
export function factsFor(now: number): World["facts"] {
  const at = Number.isFinite(now) ? now : Date.now();
  const date = new Date(at);
  const hour = date.getHours();
  const weekday = date.getDay();
  return {
    hour,
    morning: hour >= 5 && hour < 12,
    afternoon: hour >= 12 && hour < 17,
    evening: hour >= 17 && hour < 22,
    night: hour < 5 || hour >= 22,
    weekday,
    weekend: weekday === 0 || weekday === 6,
  };
}

/** Where a soul may keep its own state; one directory per soul, never shared. */
export function storeDirFor(soul: string): string {
  return join(homedir(), ".local", "share", "pi-souls", soul);
}

/** Everything a voice module learns about the moment's surroundings. */
export function worldFor(input: { now: number; sessionId: string; cwd: string; soul: string; absenceMs?: number }): World {
  const { now, sessionId, cwd, soul, absenceMs } = input;
  return {
    now,
    sessionId,
    cwd,
    storeDir: storeDirFor(soul),
    facts: factsFor(now),
    ...(typeof absenceMs === "number" && Number.isFinite(absenceMs) && absenceMs >= 0 ? { absenceMs } : {}),
  };
}

function pick(value: unknown): Voice | undefined {
  if (!object(value)) return undefined;
  if (typeof value.voice === "function") return value.voice as Voice;
  return typeof value.default === "function" ? (value.default as Voice) : undefined;
}

/** Only a nonempty text with a known audience is an utterance; anything else is ignored. */
export function utterance(value: unknown): Utterance | undefined {
  if (!object(value)) return undefined;
  const { text, audience } = value;
  if (typeof text !== "string" || !text.trim()) return undefined;
  const known = audience === "model" || audience === "human" || audience === "both" ? audience : undefined;
  return { text, ...(known ? { audience: known } : {}) };
}

/**
 * Load one soul's voice module, once. A broken module, a throwing call, or a
 * malformed answer is swallowed: voice may never break the host's request.
 */
export function loadVoice(voicePath: string): Voice {
  let loaded: Promise<Voice | undefined> | undefined;
  const load = (): Promise<Voice | undefined> =>
    (loaded ??= import(pathToFileURL(voicePath).href).then(pick).catch(() => undefined));
  return async (moment, world) => {
    const voice = await load();
    if (!voice) return undefined;
    try {
      return utterance(await voice(moment, world));
    } catch {
      return undefined;
    }
  };
}
