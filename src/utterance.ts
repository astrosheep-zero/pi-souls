export type UtteranceKind = "reminder" | "user" | "assistant";

export function isUtteranceKind(kind: unknown): kind is UtteranceKind {
  return kind === "reminder" || kind === "user" || kind === "assistant";
}

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

export type PersistentUtterance = {
  kind: UtteranceKind;
  text: string;
  ephemeral?: false;
  linger?: never;
  sink?: never;
};

export type EphemeralUtterance = {
  kind: UtteranceKind;
  text: string;
  ephemeral: true;
  linger?: number;
  sink?: number;
};

export type Utterance = PersistentUtterance | EphemeralUtterance;

/** Validate the entire batch before a caller can deliver any of it. */
export function utterances(value: unknown): readonly Utterance[] {
  if (!Array.isArray(value)) return [];
  const batch: Utterance[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item) || "raw" in item) return [];
    const { kind, text, ephemeral, linger, sink } = item;
    if (!isUtteranceKind(kind) || typeof text !== "string" || !text.trim()) return [];
    if (ephemeral === true) {
      if ("linger" in item && (typeof linger !== "number" || !Number.isInteger(linger) || linger < 1)) return [];
      if ("sink" in item && (typeof sink !== "number" || !Number.isInteger(sink) || sink < 0)) return [];
      batch.push({ kind, text, ephemeral, ...(linger === undefined ? {} : { linger }), ...(sink === undefined ? {} : { sink }) });
    } else {
      if (("ephemeral" in item && ephemeral !== false) || "linger" in item || "sink" in item) return [];
      batch.push({ kind, text, ...(ephemeral === false ? { ephemeral } : {}) });
    }
  }
  return batch;
}
