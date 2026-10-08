import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripFrontmatter, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "pi-souls:selection";
export interface SoulConfig {
  defaultSoul?: unknown;
  modelSouls: Record<string, unknown>;
  dir: string;
}
export interface Selection {
  name: string;
  source: "session" | "model" | "default";
}

export function isSoulName(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value) && value !== "clear";
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
  return { defaultSoul, modelSouls, dir };
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

function named(name: unknown, source: Selection["source"], setting: string): Selection {
  if (!isSoulName(name)) throw new Error(`${setting}: invalid soul ${JSON.stringify(name)}`);
  return { name, source };
}

export function resolveSoul(config: SoulConfig, override: string | undefined, model?: { provider: string; id: string }): Selection | undefined {
  if (override) return { name: override, source: "session" };
  const key = model && `${model.provider}/${model.id}`;
  if (key && Object.hasOwn(config.modelSouls, key)) return named(config.modelSouls[key], "model", `modelSouls["${key}"]`);
  if (config.defaultSoul !== undefined) return named(config.defaultSoul, "default", "defaultSoul");
  return undefined;
}

export function listSouls(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)).filter(isSoulName).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Small local files are read fresh; no cache invalidation protocol or watchers needed. */
export function loadSoul(dir: string, name: string): string {
  if (!isSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  const path = join(dir, `${name}.md`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Soul "${name}" not found: ${path}`);
    throw error;
  }
  const body = stripFrontmatter(text).trim();
  if (!body) throw new Error(`Soul "${name}" is empty`);
  return body;
}
