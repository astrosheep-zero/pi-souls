import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { PERCEPTION_MESSAGE_TYPE } from "./perception.ts";
import type { SoulConfig } from "./soul-content.ts";
import { isSoulName, matchingModelKey } from "./soul-selection.ts";

export { listSouls, loadSoul, readConfig, readSoul, soulFile, soulPerceptionPath, type SoulConfig, type SoulFile, type SoulVariables } from "./soul-content.ts";
export { isSoulName } from "./soul-selection.ts";

export const ENTRY_TYPE = "pi-souls:selection";
export const NAKED_ENTRY_TYPE = "pi-souls:naked";
export const NOTOOLS_ENTRY_TYPE = "pi-souls:notools";
export interface Selection {
  name: string;
  source: "session" | "model" | "default";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that can never match a model; surfaced by /soul instead of failing every request. */
export function unmatchableModelKeys(config: SoulConfig): string[] {
  return Object.keys(config.modelSouls).filter((key) => !/^[^/]+\/.+$/.test(key));
}

/** A name selects a soul, null explicitly disables souls, undefined follows defaults. */
export type SoulOverride = string | null | undefined;
/** true/false overrides naked mode for the session; undefined follows the --naked flag. */
export type NakedOverride = boolean | undefined;
export type NoToolsOverride = boolean | undefined;

/** Read a boolean session toggle from the active branch, never a second in-memory authority. */
function sessionToggle(branch: readonly SessionEntry[], customType: string, field: string, error: string): boolean | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== customType) continue;
    const value = object(entry.data) && entry.data.version === 1 ? entry.data[field] : undefined;
    if (value !== null && typeof value !== "boolean") throw new Error(error);
    return value ?? undefined;
  }
  return undefined;
}

export const sessionNaked = (branch: readonly SessionEntry[]): NakedOverride =>
  sessionToggle(branch, NAKED_ENTRY_TYPE, "naked", "Corrupted naked entry. Run /soul reset");
export const resolveNaked = (override: NakedOverride, flag = false): boolean => override ?? flag;

export const sessionNoTools = (branch: readonly SessionEntry[]): NoToolsOverride =>
  sessionToggle(branch, NOTOOLS_ENTRY_TYPE, "notools", "Corrupted notools entry. Run /notools off");
export const resolveNoTools = (override: NoToolsOverride): boolean => override ?? false;

/** Read the active branch, never the whole session file or a second in-memory authority. */
export function sessionSoul(branch: readonly SessionEntry[]): SoulOverride {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    if (!object(entry.data) || entry.data.version !== 1 || !(entry.data.name === null || isSoulName(entry.data.name))
      || (entry.data.disabled !== undefined && typeof entry.data.disabled !== "boolean")
      || (entry.data.disabled === true && entry.data.name !== null)) {
      throw new Error("Corrupted soul entry. Run /soul clear");
    }
    // Existing name:null entries mean defaults; an explicit flag records session opt-out.
    return entry.data.disabled === true ? null : entry.data.name ?? undefined;
  }
  return undefined;
}

/** Timestamp of the most recent time note on the active branch. */
export function lastTimeNoteTimestamp(branch: readonly SessionEntry[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom_message" || entry.customType !== PERCEPTION_MESSAGE_TYPE) continue;
    const timestamp = object(entry.details) ? entry.details.timestamp : undefined;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
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

export function resolveSoul(config: SoulConfig, override: SoulOverride, model?: { provider: string; id: string }, soulless = false): Selection | undefined {
  if (override === null) return undefined;
  if (override) return { name: override, source: "session" };
  if (soulless) return undefined;
  const key = model && `${model.provider}/${model.id}`;
  if (key) {
    const keys = Object.keys(config.modelSouls).filter((pattern) => pattern === key || /^[^/]+\/.+$/.test(pattern));
    const match = matchingModelKey(key, keys);
    if (match !== undefined) return named(config.modelSouls[match], "model", `modelSouls["${match}"]`);
  }
  if (config.defaultSoul !== undefined) return named(config.defaultSoul, "default", "defaultSoul");
  return undefined;
}

/** A settings soul is only a default: the user's explicit system prompt outranks it, a session choice does not. */
export function effectiveSoul(selection: Selection | undefined, customPrompt: string | undefined): Selection | undefined {
  return selection?.source === "session" || !customPrompt ? selection : undefined;
}
