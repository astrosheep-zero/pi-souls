import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripFrontmatter, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "pi-souls:selection";
export interface SoulConfig {
  defaultSoul?: string;
  modelSouls: Record<string, string>;
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

export function readConfig(settings: unknown, cwd: string): SoulConfig {
  if (!object(settings)) throw new Error("Invalid Pi settings");
  const { defaultSoul, modelSouls = {}, soulsDir = "~/.agents/souls" } = settings;
  if (defaultSoul !== undefined && !isSoulName(defaultSoul)) throw new Error("defaultSoul must be a soul name");
  if (!object(modelSouls) || Object.entries(modelSouls).some(([key, value]) => !/^[^/]+\/.+$/.test(key) || !isSoulName(value))) {
    throw new Error("modelSouls must map exact provider/modelId keys to soul names");
  }
  if (typeof soulsDir !== "string" || !soulsDir.trim()) throw new Error("soulsDir must be a directory path");
  const dir = soulsDir.startsWith("~/") ? join(homedir(), soulsDir.slice(2)) : resolve(cwd, soulsDir);
  return { defaultSoul, modelSouls: modelSouls as Record<string, string>, dir };
}

/** Read the active branch, never the whole session file or a second in-memory authority. */
export function sessionSoul(branch: readonly SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    if (!object(entry.data) || entry.data.version !== 1 || !(entry.data.name === null || isSoulName(entry.data.name))) {
      throw new Error("Invalid soul selection in session branch");
    }
    return entry.data.name ?? undefined;
  }
  return undefined;
}

export function resolveSoul(config: SoulConfig, override: string | undefined, model?: { provider: string; id: string }): Selection | undefined {
  if (override) return { name: override, source: "session" };
  const modelSoul = model && config.modelSouls[`${model.provider}/${model.id}`];
  if (modelSoul) return { name: modelSoul, source: "model" };
  if (config.defaultSoul) return { name: config.defaultSoul, source: "default" };
  return undefined;
}

export function listSouls(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)).filter(isSoulName).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Small local files are read fresh; no cache invalidation protocol or watchers needed. */
export function loadSoul(dir: string, name: string): string {
  if (!isSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  const path = join(dir, `${name}.md`);
  const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
  if (!body) throw new Error(`Soul file is empty: ${path}`);
  return body;
}
