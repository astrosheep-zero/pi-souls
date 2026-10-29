import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Liquid } from "liquidjs";

export const ENTRY_TYPE = "pi-souls:selection";
export const TIME_ENTRY_TYPE = "pi-souls:time";
export interface SoulFile {
  body: string;
  icon?: string;
}
export interface SoulConfig {
  defaultSoul?: unknown;
  modelSouls: Record<string, unknown>;
  dir: string;
  timeaware: boolean;
}
export interface Selection {
  name: string;
  source: "session" | "model" | "default";
}
export interface SoulVariables {
  model: { provider: string; id: string };
  cwd: string;
}

const EMPTY_VARIABLES: SoulVariables = { model: { provider: "", id: "" }, cwd: "" };

export function isSoulName(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the shape is checked here; soul names are checked when used, so one bad entry never disables the rest. */
export function readConfig(settings: unknown, cwd: string): SoulConfig {
  if (!object(settings)) throw new Error("Invalid Pi settings");
  const { defaultSoul, modelSouls = {}, soulsDir = "~/.agents/souls" } = settings;
  if (!object(modelSouls)) throw new Error("modelSouls must be an object");
  if (typeof soulsDir !== "string" || !soulsDir.trim()) throw new Error("soulsDir must be a path");
  const dir = soulsDir === "~" || soulsDir.startsWith("~/") ? join(homedir(), soulsDir.slice(2)) : resolve(cwd, soulsDir);
  return { defaultSoul, modelSouls, dir, timeaware: settings.timeaware !== false };
}

/** Keys that can never match a model; surfaced by /soul instead of failing every request. */
export function unmatchableModelKeys(config: SoulConfig): string[] {
  return Object.keys(config.modelSouls).filter((key) => !/^[^/]+\/.+$/.test(key));
}

/** Read the active branch, never the whole session file or a second in-memory authority. */
export function sessionSoul(branch: readonly SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    if (!object(entry.data) || entry.data.version !== 1 || !(entry.data.name === null || isSoulName(entry.data.name))) {
      throw new Error("Corrupted soul entry. Run /soul clear");
    }
    return entry.data.name ?? undefined;
  }
  return undefined;
}

/** Timestamp of the most recent time note on the active branch. */
export function lastTimeNoteTimestamp(branch: readonly SessionEntry[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom_message" || entry.customType !== TIME_ENTRY_TYPE) continue;
    const details = entry.details;
    if (typeof details === "object" && details !== null && typeof (details as { timestamp?: unknown }).timestamp === "number") {
      return (details as { timestamp: number }).timestamp;
    }
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Timestamp of the most recent user message on the active branch before this run's prompt is appended. */
export function lastUserMessageTimestamp(branch: readonly SessionEntry[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    if (typeof entry.message.timestamp === "number" && Number.isFinite(entry.message.timestamp)) return entry.message.timestamp;
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function named(name: unknown, source: Selection["source"], setting: string): Selection {
  if (!isSoulName(name)) throw new Error(`${setting}: invalid soul ${JSON.stringify(name)}`);
  return { name, source };
}

export function resolveSoul(config: SoulConfig, override: string | undefined, model?: { provider: string; id: string }, soulless = false): Selection | undefined {
  if (override) return { name: override, source: "session" };
  if (soulless) return undefined;
  const key = model && `${model.provider}/${model.id}`;
  if (key && Object.hasOwn(config.modelSouls, key)) return named(config.modelSouls[key], "model", `modelSouls["${key}"]`);
  if (config.defaultSoul !== undefined) return named(config.defaultSoul, "default", "defaultSoul");
  return undefined;
}

/** A settings soul is only a default: the user's explicit system prompt outranks it, a session choice does not. */
export function effectiveSoul(selection: Selection | undefined, customPrompt: string | undefined): Selection | undefined {
  return selection?.source === "session" || !customPrompt ? selection : undefined;
}

/** A single file soul is `<name>.md`; a directory soul is `<name>/SOUL.md` plus whatever it keeps beside it. */
export function soulFile(dir: string, name: string): { path: string; root: string[] } {
  const nested = join(dir, name, "SOUL.md");
  if (existsSync(nested)) return { path: nested, root: [join(dir, name), dir] };
  return { path: join(dir, `${name}.md`), root: [dir] };
}

const REACTION_EXTENSIONS = [".ts", ".mjs", ".js"] as const;

/** The executable reaction of a directory soul, if it ships one. */
export function soulReactionPath(dir: string, name: string): string | undefined {
  if (!isSoulName(name)) return undefined;
  for (const extension of REACTION_EXTENSIONS) {
    const path = join(dir, name, `reaction${extension}`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** File souls and directory souls are one list of names, sorted once. */
export function listSouls(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.isDirectory() ? entry.name : entry.name.endsWith(".md") ? entry.name.slice(0, -3) : undefined;
    if (name === undefined || !isSoulName(name)) continue;
    if (entry.isDirectory() ? existsSync(join(dir, name, "SOUL.md")) : entry.isFile()) names.add(name);
  }
  return [...names].sort();
}

/** Small local files are read fresh; no cache invalidation protocol or watchers needed. */
export function readSoul(dir: string, name: string, variables: SoulVariables = EMPTY_VARIABLES): SoulFile {
  if (!isSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  const { path, root } = soulFile(dir, name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Soul "${name}" not found: ${path}`);
    throw new Error(`Soul "${name}" unreadable: ${path} (${code ?? String(error)})`);
  }
  const parsed = parseFrontmatter<Record<string, unknown>>(text);
  // A directory soul renders from its own folder first, so `parts/` next to it wins over the shared one.
  const engine = new Liquid({ root, extname: ".md", strictVariables: true, strictFilters: true, globals: variables });
  let body: string;
  try {
    body = engine.renderSync(engine.parse(parsed.body, path)).trim();
  } catch (error) {
    throw new Error(`Soul "${name}" template: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!body) throw new Error(`Soul "${name}" is empty`);
  const raw = object(parsed.frontmatter) ? parsed.frontmatter.icon : undefined;
  const icon = typeof raw === "string" ? raw.trim() : "";
  return { body, ...(icon ? { icon } : {}) };
}

export function loadSoul(dir: string, name: string, variables?: SoulVariables): string {
  return readSoul(dir, name, variables).body;
}
