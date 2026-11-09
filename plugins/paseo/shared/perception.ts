import { z } from "zod";

export const PERCEPTION_MESSAGE_TYPE = "pi-souls:perception";

const REMINDER_OPEN = "<system-reminder>\n";
const REMINDER_CLOSE = "\n</system-reminder>";

export function unwrapReminder(text: string): string {
  return text.startsWith(REMINDER_OPEN) && text.endsWith(REMINDER_CLOSE)
    ? text.slice(REMINDER_OPEN.length, -REMINDER_CLOSE.length)
    : text;
}

/** Clean theatre bracket thoughts and coalesce standalone `[speaker]` lines with the line that follows. */
export function compactPerceptionLines(text: string): string[] {
  const cleaned = text.replace(/``\s*(\[[^\]]*\])\s*``/g, "$1");
  const raw = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (/^\[[^\]]+\]$/.test(line) && i + 1 < raw.length && !/^\[[^\]]+\]$/.test(raw[i + 1]!)) {
      out.push(`${line} ${raw[i + 1]!}`);
      i++;
    } else {
      out.push(line);
    }
  }
  return out;
}

export const PERCEPTION_KIND = "perception";

export const perceptionSchema = z.object({
  text: z.string().min(1),
});

export type PerceptionData = z.infer<typeof perceptionSchema>;
