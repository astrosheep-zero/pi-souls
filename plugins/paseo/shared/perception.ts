import { z } from "zod";

export const PERCEPTION_MESSAGE_TYPE = "pi-souls:perception";

const REMINDER_OPEN = "<system-reminder>\n";
const REMINDER_CLOSE = "\n</system-reminder>";

export function unwrapReminder(text: string): string {
  return text.startsWith(REMINDER_OPEN) && text.endsWith(REMINDER_CLOSE)
    ? text.slice(REMINDER_OPEN.length, -REMINDER_CLOSE.length)
    : text;
}

const isUtteranceKind = (value: unknown): boolean =>
  value === "reminder" || value === "user" || value === "assistant";

/** New pi-souls carriers store raw text and record `kind` (wake/tool) or `kinds` (human batch) in details. */
export function storesRawPerceptionText(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const { kind, kinds } = details as { kind?: unknown; kinds?: unknown };
  return isUtteranceKind(kind) || (Array.isArray(kinds) && kinds.length > 0 && kinds.every(isUtteranceKind));
}

export const PERCEPTION_KIND = "perception";

export const perceptionSchema = z.object({
  text: z.string().min(1),
});

export type PerceptionData = z.infer<typeof perceptionSchema>;
