import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isSoulName } from "./souls.ts";

export const TRANSITION_ENTRY_TYPE = "pi-souls:transition";
export const TRANSITION_MESSAGE_TYPE = "pi-souls:transition-reminder";

export interface TransitionModel {
  provider: string;
  id: string;
}

/** The last identities a user prompt was allowed to see. */
export interface Transition {
  model: TransitionModel | null;
  soul: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModel(value: unknown): value is TransitionModel {
  return record(value) && typeof value.provider === "string" && value.provider.length > 0
    && typeof value.id === "string" && value.id.length > 0;
}

function isSnapshot(value: unknown): value is { version: 1; model: TransitionModel | null; soul: string | null } {
  if (!record(value) || value.version !== 1) return false;
  if (!(value.model === null || isModel(value.model))) return false;
  return value.soul === null || (typeof value.soul === "string" && isSoulName(value.soul));
}

/** Read the active branch, never a whole session file or a second in-memory authority. */
export function readTransition(branch: readonly SessionEntry[]): Transition | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== TRANSITION_ENTRY_TYPE) continue;
    if (!isSnapshot(entry.data)) continue;
    return { model: entry.data.model, soul: entry.data.soul };
  }
  return undefined;
}

function sameModel(left: TransitionModel | null, right: TransitionModel | null): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

export function sameTransition(left: Transition, right: Transition): boolean {
  return left.soul === right.soul && sameModel(left.model, right.model);
}

/** Brain first, soul second; a change to none is a silent baseline update, not prose. */
export function transitionLines(previous: Transition, current: Transition): string[] {
  const lines: string[] = [];
  if (!sameModel(previous.model, current.model) && current.model) lines.push(`new brain: ${current.model.id}`);
  if (previous.soul !== current.soul && current.soul !== null) lines.push(`new soul: ${current.soul}`);
  return lines;
}

export function formatTransitionReminder(lines: readonly string[], wrap = true): string {
  const text = lines.join("\n");
  return wrap ? `<system-reminder>\n${text}\n</system-reminder>` : text;
}
