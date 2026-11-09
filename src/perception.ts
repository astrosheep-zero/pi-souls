import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PERCEPTION_MESSAGE_TYPE = "pi-souls:perception";

const REMINDER_OPEN = "<system-reminder>\n";
const REMINDER_CLOSE = "\n</system-reminder>";

export function wrapReminder(text: string): string {
  return `${REMINDER_OPEN}${text}${REMINDER_CLOSE}`;
}

export function unwrapReminder(text: string): string {
  return text.startsWith(REMINDER_OPEN) && text.endsWith(REMINDER_CLOSE)
    ? text.slice(REMINDER_OPEN.length, -REMINDER_CLOSE.length)
    : text;
}

/** Persist once and let Pi deliver it at the next safe boundary; never rebuild old reminders. */
export function sendReminder(pi: Pick<ExtensionAPI, "sendMessage">, message: {
  text: string; details?: unknown; customType?: string; display?: boolean;
  /** State notices describe the next request: settle with this run instead of steering it. */
  defer?: boolean;
}): void {
  pi.sendMessage({
    customType: message.customType ?? PERCEPTION_MESSAGE_TYPE,
    content: wrapReminder(message.text),
    display: message.display ?? true,
    details: message.details,
  }, message.defer ? { triggerTurn: false } : undefined);
}

const perceptionRequire = createRequire(import.meta.url);
const { importModule } = perceptionRequire("./perception-import.mjs") as { importModule: (url: string) => Promise<unknown> };
// A fresh Jiti evaluation retains full TypeScript support without its parent-module cache.
const importTypeScript = createJiti(import.meta.url, { moduleCache: false, tryNative: false });

/** How the host saw a tool call; a perception module reads this instead of parsing tool names. */
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
    };

export interface Utterance {
  text: string;
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

/** What a soul's `perception.ts` exports, by name or as the default. */
export type Perception = (moment: Moment, world: World) => Utterance | undefined | Promise<Utterance | undefined>;

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

/** Long tool details are cut here; a perception module gets the shape, not the whole file. */
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

/** Clock facts a perception module can branch on without re-reading the clock. */
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

/** Everything a perception module learns about the moment's surroundings. */
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

function pick(value: unknown): Perception | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.perception === "function") return record.perception as Perception;
  if (typeof record.default === "function") return record.default as Perception;
  return typeof value === "function" ? value as Perception : undefined;
}

/** Only nonempty text is an utterance. */
export function utterance(value: unknown): Utterance | undefined {
  if (!object(value)) return undefined;
  const { text } = value;
  return typeof text === "string" && text.trim() ? { text } : undefined;
}

/**
 * Load one soul's perception module, once. A broken module, a throwing call, or a
 * malformed answer is swallowed: a perception may never break the host's request.
 */
export function loadPerception(perceptionPath: string): Perception {
  let loaded: Promise<Perception | undefined> | undefined;
  const load = (): Promise<Perception | undefined> =>
    (loaded ??= (async () => {
      if (perceptionPath.endsWith(".ts")) return pick(await importTypeScript.import(perceptionPath));
      // CommonJS also caches by filename, independently of the fresh ESM URL.
      delete perceptionRequire.cache[perceptionRequire.resolve(perceptionPath)];
      return pick(await importModule(`${pathToFileURL(perceptionPath).href}?v=${randomUUID()}`));
    })().catch(() => undefined));
  return async (moment, world) => {
    const perception = await load();
    if (!perception) return undefined;
    try {
      return utterance(await perception(moment, world));
    } catch {
      return undefined;
    }
  };
}
