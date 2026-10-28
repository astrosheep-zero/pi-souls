import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { effectiveSoul, isSoulName, readSoul, resolveSoul, sessionSoul, soulVoicePath, type Selection, type SoulConfig, type SoulVariables } from "./souls.ts";

export const FOOTER_KEY = "soul";
export const PRESENCE_ENTRY_TYPE = "pi-souls:presence";

export interface Presence {
  selection: Selection;
  body: string;
  icon?: string;
}

/** The file facts for a resolved selection; throws when the soul is missing or unreadable. */
export function selectionPresence(config: SoulConfig, selection: Selection | undefined, variables?: SoulVariables): Presence | undefined {
  if (!selection) return undefined;
  const soul = readSoul(config.dir, selection.name, variables);
  return { selection, body: soul.body, ...(soul.icon ? { icon: soul.icon } : {}) };
}

/** The active soul's executable voice, when it ships one; resolved without rendering the body. */
export function resolveVoice(config: SoulConfig, selection: Selection | undefined): { name: string; path: string } | undefined {
  if (!selection) return undefined;
  const path = soulVoicePath(config.dir, selection.name);
  return path ? { name: selection.name, path } : undefined;
}

/** The soul Pi is actually using, after settings, session, custom prompt, and soulless precedence. */
export function resolvePresence(config: SoulConfig, branch: readonly SessionEntry[], model: { provider: string; id: string } | undefined, customPrompt: string | undefined, soulless = false, variables?: SoulVariables): Presence | undefined {
  return selectionPresence(config, effectiveSoul(resolveSoul(config, sessionSoul(branch), model, soulless), customPrompt), variables);
}

export function footerText(presence: Presence | undefined): string | undefined {
  if (!presence) return undefined;
  return presence.icon ?? presence.selection.name;
}

export function dividerText(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const { version, name } = data as { version?: unknown; name?: unknown };
  if (version !== 1) return undefined;
  if (name === null) return "── soulless ──";
  return typeof name === "string" && isSoulName(name) ? `── soul: ${name} ──` : undefined;
}
