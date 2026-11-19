import { z } from "zod";

export const PERCEPTION_MESSAGE_TYPE = "pi-souls:perception";

const REMINDER_OPEN = "<system-reminder>\n";
const REMINDER_CLOSE = "\n</system-reminder>";

export function unwrapReminder(text: string): string {
  return text.startsWith(REMINDER_OPEN) && text.endsWith(REMINDER_CLOSE)
    ? text.slice(REMINDER_OPEN.length, -REMINDER_CLOSE.length)
    : text;
}

export const PERCEPTION_KIND = "perception";

export const perceptionSchema = z.object({
  text: z.string().min(1),
});

export type PerceptionData = z.infer<typeof perceptionSchema>;
