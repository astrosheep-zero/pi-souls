import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { PERCEPTION_MESSAGE_TYPE, unwrapReminder } from "./perception.ts";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";
import { DAY_CHROMA, dayHue, lightness, oklch, type Rgb } from "./tint.ts";

/** Unwrap theatre bracket thoughts and keep the soul's own line breaks. */
export function compactPerceptionLines(text: string): string[] {
  const cleaned = text.replace(/``\s*(\[[^\]]*\])\s*``/g, "$1");
  return cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
}

type RenderTheme = {
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
};

type Ink = { text(s: string): string; faint(s: string): string };

const TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const rgbOf = (ansi: string): Rgb | undefined => {
  const m = TRUECOLOR.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * The theme's `dim` lightness, re-hued for the perception's day at a barely-there chroma.
 * Brackets and quotes sit one step further back. Without truecolor, plain `dim` throughout.
 */
function inkFor(theme: RenderTheme, at: Date): Ink {
  const dim = theme.getFgAnsi?.("dim") ?? "";
  const base = rgbOf(dim), text = rgbOf(theme.getFgAnsi?.("text") ?? "");
  if (!base) return { text: (s) => theme.fg("dim", s), faint: (s) => theme.fg("dim", s) };
  const hue = dayHue(at), L = lightness(base);
  // Away from the text colour is towards the background, whichever theme this is.
  const faintL = L + (L - (text ? lightness(text) : 1 - L)) * 0.35;
  const paint = (rgb: Rgb) => {
    const open = dim.replace(TRUECOLOR, `\x1b[38;2;${rgb.join(";")}m`);
    const close = open.includes("\x1b[2m") ? "\x1b[22m\x1b[39m" : "\x1b[39m";
    return (s: string) => `${open}${s}${close}`;
  };
  return { text: paint(oklch(L, DAY_CHROMA, hue)), faint: paint(oklch(faintL, DAY_CHROMA, hue)) };
}

/** One colour for the whole perception; only the brackets and quotes step back. `*action*` loses its stars. */
function stylePerceptionLine(line: string, ink: Ink): string {
  return line
    .replace(/\*([^*\n]+)\*/g, "$1")
    .split(/([\[\]“”"])/g)
    .filter(Boolean)
    .map((part) => (/^[\[\]“”"]$/.test(part) ? ink.faint(part) : ink.text(part)))
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
    // No rule, no box: an indent and the day's ink are what set it apart from the reply.
    const indent = " ".repeat((options.outputPad ?? 1) + 2);
    const at = new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now());
    return {
      invalidate() {},
      render(width: number): string[] {
        const ink = inkFor(theme, at);
        const contentWidth = Math.max(1, width - indent.length);
        const wrapped: string[] = [];
        for (const line of lines) {
          const rendered = new Text(stylePerceptionLine(line, ink), 0, 0).render(contentWidth);
          for (const vline of rendered) wrapped.push(vline.trimEnd());
        }
        if (options.expanded || wrapped.length <= 2) {
          return wrapped.map((line) => indent + line);
        }
        const preview = wrapped.slice(0, 2);
        const tail = ` ${ink.faint("⋯")}`;
        preview[1] = truncateToWidth(preview[1]!, contentWidth - 2, "") + tail;
        return preview.map((line) => indent + line);
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
