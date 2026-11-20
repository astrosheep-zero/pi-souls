/** Pure reader for the active ancestry of a Claude transcript. No host APIs. */
import { isSoulName } from "./soul-selection.ts";
import { DAYS, MONTHS } from "./time.ts";

export type SoulChoice =
  | { mode: "named"; name: string }
  | { mode: "disabled" }
  | { mode: "defaults" };

export interface ClaudeSnapshot {
  systemPrompt: string[];
}

export interface ClaudeSession {
  known: boolean;
  choice?: SoulChoice;
  lastHumanAt?: number;
  previousHumanAt?: number;
  noteAt?: number;
  model?: string;
  soul?: string | null;
  /** Live-chain nonmeta user/assistant carrier UUIDs for the latest own records. */
  retainHandles?: string[];
  /** Present only when an explicit native rewind anchor was adopted. */
  headUuid?: string | null;
  snapshot?: ClaudeSnapshot;
}

type Row = Record<string, unknown>;

interface Reading {
  result: ClaudeSession;
  brain?: string;
  soulReminder?: boolean;
  assistant?: string;
  pending: Set<RetainKind>;
  selected: Set<RetainKind>;
}

type RetainKind = "choice" | "divider" | "clock" | "brain" | "soul";

interface Used extends Partial<Record<RetainKind, true>> {}

interface Version {
  row: Row;
  index: number;
}

interface Node {
  versions: Version[];
}

const CHOICE_PREFIX = "Soul choice:";
const DIVIDER_NONE = "── soulless ──";
const DIVIDER_SOUL = /^── soul: (.+) ──$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function named(value: string): { mode: "named"; name: string } {
  if (!isSoulName(value)) throw new Error(`Invalid soul name in Claude notice: ${JSON.stringify(value)}`);
  return { mode: "named", name: value };
}

/** The exact version-1 choice line. */
export function encodeChoice(choice: SoulChoice): string {
  switch (choice.mode) {
    case "named":
      if (!isSoulName(choice.name)) throw new Error(`Invalid soul name: ${JSON.stringify(choice.name)}`);
      return `${CHOICE_PREFIX} @${choice.name}`;
    case "disabled":
      return `${CHOICE_PREFIX} disabled`;
    case "defaults":
      return `${CHOICE_PREFIX} defaults`;
  }
}

/** Parse the exact trimmed choice notice. Unrelated text is undefined; a malformed own marker throws. */
export function decodeChoice(text: string): SoulChoice | undefined {
  const line = text.trim();
  if (!line.startsWith(CHOICE_PREFIX)) return undefined;
  const value = line.slice(CHOICE_PREFIX.length).trim();
  if (value === "disabled") return { mode: "disabled" };
  if (value === "defaults") return { mode: "defaults" };
  if (value.startsWith("@") && isSoulName(value.slice(1))) return named(value.slice(1));
  throw new Error(`Invalid soul choice notice: ${JSON.stringify(line)}`);
}

function decodeDivider(text: string): string | null | undefined {
  const line = text.trim();
  if (line === DIVIDER_NONE) return null;
  const match = DIVIDER_SOUL.exec(line);
  if (match) return named(match[1]!).name;
  if (line.startsWith("── soul") || line.startsWith("── soulless")) {
    throw new Error(`Invalid soul divider: ${JSON.stringify(line)}`);
  }
  return undefined;
}

function decodeNewSoul(line: string): string | undefined {
  const text = line.trim();
  if (!text.startsWith("new soul:")) return undefined;
  const value = text.slice("new soul:".length).trim();
  if (!value) throw new Error(`Invalid new soul reminder: ${JSON.stringify(text)}`);
  return named(value).name;
}

function decodeNewBrain(line: string): string | undefined {
  const text = line.trim();
  if (!text.startsWith("new brain:")) return undefined;
  const value = text.slice("new brain:".length).trim();
  if (!value) throw new Error(`Invalid new brain reminder: ${JSON.stringify(text)}`);
  return value;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") return [];
    return [block.text];
  }).join("\n");
}

function rowText(row: Row): string {
  if (row.type === "user" || row.type === "assistant") {
    const message = record(row.message) ? row.message : undefined;
    return message ? contentText(message.content) : "";
  }
  return contentText(row.content);
}

function mainRow(row: Row): boolean {
  return row.isSidechain !== true && row.agentId == null;
}

const LOCAL_COMMAND_ENVELOPE = /^<(?:command-name|local-command-caveat|local-command-stdout|local-command-stderr)>/;

function isHuman(row: Row): boolean {
  if (!mainRow(row) || row.type !== "user" || row.isMeta === true || row.isCompactSummary === true) return false;
  const message = record(row.message) ? row.message : undefined;
  if (!message || message.role !== "user") return false;
  if (Array.isArray(message.content) && message.content.some((block) => record(block) && block.type === "tool_result")) return false;
  return !LOCAL_COMMAND_ENVELOPE.test(rowText(row));
}

function hasPluginOrigin(row: Row): boolean {
  const origin = record(row.origin) ? row.origin : undefined;
  return origin?.kind === "plugin" && origin.name === "pi-souls";
}

/** Reminders are our own meta user rows, never arbitrary system prose or another plugin's reminder. */
function isReminderRow(row: Row): boolean {
  return mainRow(row) && row.type === "user" && row.isMeta === true && hasPluginOrigin(row);
}

const REMINDER_WRAPPER = /^\s*<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;

/** Claude wraps plugin reminders in a system-reminder text block. */
function reminderText(text: string): string {
  const match = REMINDER_WRAPPER.exec(text);
  return (match ? match[1]! : text).trim();
}

const CLOCK_LINE = new RegExp(`^⌚ (?:[01]\\d|2[0-3]):[0-5]\\d · (?:${DAYS.join("|")}), (?:${MONTHS.join("|")}) (?:[1-9]|[12]\\d|3[01])$`, "u");

function hasSubmitClock(row: Row): boolean {
  // Claude stores the submit hook name but no plugin origin on these attachments.
  const attachment = row.type === "attachment" && record(row.attachment) ? row.attachment : undefined;
  return attachment?.type === "hook_additional_context" && attachment.hookName === "prompt.submit"
    && Array.isArray(attachment.content) && attachment.content.some((part) =>
      typeof part === "string" && reminderText(part).split(/\r?\n/).some((line) => CLOCK_LINE.test(line)));
}

/** Selection and divider records are owned informational system notices. */
function ownedNotice(row: Row): string | undefined {
  if (!mainRow(row) || row.type !== "system" || row.subtype !== "informational") return undefined;
  return typeof row.content === "string" ? row.content : undefined;
}

function timestampOf(row: Row): number | undefined {
  const value = row.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parentOf(row: Row): string | undefined {
  const value = row.parentUuid;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function logicalParentOf(row: Row): string | undefined {
  if (row.type !== "system" || row.subtype !== "compact_boundary") return undefined;
  return parentOf({ parentUuid: row.logicalParentUuid });
}

function trackRetention(row: Row, used: Used, reading: Reading, handles: ReadonlySet<string>): void {
  const uuid = typeof row.uuid === "string" ? row.uuid : undefined;
  if (uuid !== undefined && handles.has(uuid)) {
    if (reading.pending.size > 0) {
      const retained = reading.result.retainHandles ?? (reading.result.retainHandles = []);
      if (!retained.includes(uuid)) retained.push(uuid);
      reading.pending.clear();
    }
    return;
  }
  for (const kind of Object.keys(used) as RetainKind[]) {
    if (reading.selected.has(kind)) continue;
    reading.selected.add(kind);
    reading.pending.add(kind);
  }
}

function inspect(row: Row, reading: Reading): Used {
  const { result } = reading;
  if (!mainRow(row)) return {};
  const used: Used = {};
  const at = timestampOf(row);

  const notice = ownedNotice(row);
  if (notice !== undefined && result.choice === undefined) {
    const choice = decodeChoice(notice);
    if (choice !== undefined) {
      result.choice = choice;
      used.choice = true;
    }
  }
  if (notice !== undefined && result.soul === undefined) {
    const divider = decodeDivider(notice);
    if (divider !== undefined) {
      result.soul = divider;
      used.divider = true;
    }
  }

  const reminder = isReminderRow(row) ? reminderText(rowText(row)) : undefined;
  if (reminder !== undefined) {
    for (const line of reminder.split(/\r?\n/)) {
      if (!reading.soulReminder) {
        const soul = decodeNewSoul(line);
        if (soul !== undefined) {
          reading.soulReminder = true;
          used.soul = true;
          if (result.soul === undefined) result.soul = soul;
        }
      }
      if (reading.brain === undefined) {
        const model = decodeNewBrain(line);
        if (model !== undefined) {
          reading.brain = model;
          used.brain = true;
        }
      }
    }
  }
  if (result.noteAt === undefined && at !== undefined && (reminder?.startsWith("⌚") || hasSubmitClock(row))) {
    result.noteAt = at;
    used.clock = true;
  }

  if (isHuman(row) && at !== undefined) {
    if (result.lastHumanAt === undefined) result.lastHumanAt = at;
    else if (result.previousHumanAt === undefined) result.previousHumanAt = at;
  }

  if (reading.assistant === undefined && row.type === "assistant") {
    const message = record(row.message) ? row.message : undefined;
    if (message && typeof message.model === "string" && message.model) reading.assistant = message.model;
  }

  if (result.snapshot === undefined && row.type === "attachment") {
    const attachment = record(row.attachment) ? row.attachment : undefined;
    if (attachment && attachment.type === "prompt_snapshot" && Array.isArray(attachment.systemPrompt)
      && attachment.systemPrompt.every((part) => typeof part === "string")) {
      result.snapshot = {
        systemPrompt: [...attachment.systemPrompt],
      };
    }
  }
  return used;
}

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      throw new Error(`Invalid Claude transcript JSON at line ${index + 1}`);
    }
    if (!record(value) || typeof value.type !== "string") {
      throw new Error(`Invalid Claude transcript row at line ${index + 1}`);
    }
    rows.push(value);
  }
  return rows;
}

function versionAt(node: Node, cutoff: number | undefined): Version | undefined {
  if (cutoff === undefined) return node.versions[node.versions.length - 1];
  for (let index = node.versions.length - 1; index >= 0; index--) {
    const version = node.versions[index]!;
    if (version.index < cutoff) return version;
  }
  return undefined;
}

/**
 * Read the branch ending at `headUuid`.
 *
 * The head is a kept main-session append. A missing or unflushed head is not a
 * default choice: `known` is false and no selection is returned. A malformed
 * own notice on the active ancestry throws. `handles` are the host's live
 * nonmeta user/assistant handles; each selected live record keeps the nearest
 * ancestor handle. With `sessionId`, one explicit native rewind marker that
 * follows the tracked head row may replace the effective head; `result.headUuid`
 * says which head was adopted.
 */
export function readClaudeSession(text: string, headUuid: string, handles: readonly string[] = [], sessionId?: string): ClaudeSession {
  const head = headUuid.trim();
  if (!head) return { known: false };

  const rows = parseRows(text);
  const nodes = new Map<string, Node>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (typeof row.uuid !== "string" || !row.uuid) continue;
    const node = nodes.get(row.uuid);
    if (node) node.versions.push({ row, index });
    else nodes.set(row.uuid, { versions: [{ row, index }] });
  }
  const headNode = nodes.get(head);
  if (headNode === undefined) return { known: false };
  const headVersion = headNode.versions[headNode.versions.length - 1]!;

  let effectiveHead = head;
  let adoptedHead: string | null | undefined;
  if (sessionId !== undefined) {
    const headSession = headVersion.row.sessionId;
    if (typeof headSession !== "string" || headSession === sessionId) {
      for (let index = rows.length - 1; index > headVersion.index; index--) {
        const row = rows[index]!;
        if (row.type !== "last-prompt" || row.explicit !== true || row.rewound !== true || row.sessionId !== sessionId) continue;

        const leaf = row.leafUuid;
        if (leaf === null) {
          return { known: true, headUuid: null, retainHandles: [] };
        }
        if (typeof leaf === "string" && leaf.length > 0) {
          const anchor = nodes.get(leaf);
          if (anchor === undefined) return { known: false };
          const anchorVersion = anchor.versions[anchor.versions.length - 1]!;
          const anchorSession = anchorVersion.row.sessionId;
          if (typeof anchorSession === "string" && anchorSession !== sessionId) return { known: false };
          if (anchorVersion.index >= index) return { known: false };
          adoptedHead = leaf;
          effectiveHead = leaf;
        }
        break;
      }
    }
  }

  const reading: Reading = {
    result: { known: true, retainHandles: [] },
    pending: new Set(),
    selected: new Set(),
  };
  const providedHandles = new Set(handles.filter((handle) => typeof handle === "string" && handle.length > 0));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  let liveBroken = false;
  let oldBroken = false;
  type Step = { uuid: string; historical: boolean; cutoff?: number; exit?: boolean };
  const stack: Step[] = [{ uuid: effectiveHead, historical: false }];

  while (stack.length > 0) {
    const step = stack.pop()!;
    const key = step.historical ? `old:${step.cutoff}:${step.uuid}` : `live:${step.uuid}`;
    if (step.exit) {
      visiting.delete(key);
      visited.add(key);
      continue;
    }
    if (visited.has(key)) continue;
    if (visiting.has(key)) {
      if (step.historical) oldBroken = true;
      else liveBroken = true;
      continue;
    }
    const node = nodes.get(step.uuid);
    const version = node === undefined ? undefined : versionAt(node, step.historical ? step.cutoff : undefined);
    if (version === undefined) {
      if (step.historical) oldBroken = true;
      else liveBroken = true;
      continue;
    }

    visiting.add(key);
    stack.push({ ...step, exit: true });
    // Live ancestry uses the latest UUID version. Compact history uses the
    // latest version before its boundary, so preserved-message reparenting
    // after the boundary cannot loop back through the summary.
    const row = version.row;
    const used = inspect(row, reading);
    if (!step.historical) trackRetention(row, used, reading, providedHandles);

    const parent = parentOf(row);
    const logical = logicalParentOf(row);
    // Logical history is pushed first so the live parent chain is read first.
    if (logical !== undefined) stack.push({ uuid: logical, historical: true, cutoff: version.index });
    if (parent !== undefined) stack.push({ uuid: parent, historical: step.historical, ...(step.historical ? { cutoff: step.cutoff } : {}) });
  }

  // A delivered brain marker is canonical; the backend's message.model is only a fallback.
  if (reading.brain !== undefined) reading.result.model = reading.brain;
  else if (reading.assistant !== undefined) reading.result.model = reading.assistant;

  // A broken live chain is never a default. A broken compact-history chain is
  // safe only when the live window already yielded an explicit choice; without
  // one, the old choice may be missing and the answer is unknown.
  if (liveBroken) return { known: false };
  if (oldBroken && reading.result.choice === undefined) return { known: false };
  if (adoptedHead !== undefined) reading.result.headUuid = adoptedHead;
  return reading.result;
}
