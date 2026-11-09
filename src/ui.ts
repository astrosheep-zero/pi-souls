import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { PERCEPTION_MESSAGE_TYPE, unwrapReminder } from "./perception.ts";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";

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

type RenderTheme = {
  fg(color: string, text: string): string;
  italic?(text: string): string;
};

/** Style `[speaker]` tags and `*action*` spans along a single perception line. */
function stylePerceptionLine(line: string, theme: RenderTheme): string {
  const italic = (s: string) => (theme.italic ? theme.italic(s) : s);
  const parts = line.split(/(\[[^\]]+\]|\*[^*\n]+\*)/g);
  return parts
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith("[") && part.endsWith("]")) return theme.fg("muted", part);
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        return theme.fg("dim", italic(part.slice(1, -1)));
      }
      return theme.fg("dim", part);
    })
    .join("");
}

export function registerPresenceUI(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(PRESENCE_ENTRY_TYPE, (entry, _options, theme) => {
    const text = dividerText(entry.data);
    return text === undefined ? undefined : new Text(theme.fg("dim", text), 0, 0);
  });
  pi.registerMessageRenderer?.(PERCEPTION_MESSAGE_TYPE, (message, options, theme) => {
    const raw = typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const text = unwrapReminder(raw).trim();
    if (!text) return undefined;
    const lines = compactPerceptionLines(text);
    if (!lines.length) return undefined;
    const pad = " ".repeat(options.outputPad ?? 1);
    const guide = `${pad}${theme.fg("borderMuted", "│ ")}`;
    return {
      invalidate() {},
      render(width: number): string[] {
        const contentWidth = Math.max(1, width - (options.outputPad ?? 1) - 2);
        const wrapped: string[] = [];
        for (const line of lines) {
          const rendered = new Text(stylePerceptionLine(line, theme), 0, 0).render(contentWidth);
          for (const vline of rendered) wrapped.push(vline.trimEnd());
        }
        if (options.expanded || wrapped.length <= 2) {
          return wrapped.map((line) => guide + line);
        }
        const preview = wrapped.slice(0, 2);
        preview[1] = truncateToWidth(`${preview[1]!}${theme.fg("muted", "…")}`, contentWidth);
        return preview.map((line) => guide + line);
      },
    };
  });
}

export function setFooter(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(FOOTER_KEY, text);
}

export function appendDivider(pi: ExtensionAPI, name: string | null): void {
  pi.appendEntry(PRESENCE_ENTRY_TYPE, { version: 1, name });
}
