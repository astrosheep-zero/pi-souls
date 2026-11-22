import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { PERCEPTION_MESSAGE_TYPE } from "./perception.ts";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";
import { dayHue, dayPalette, lightness, type Rgb } from "./tint.ts";
import { isUtteranceKind, unwrapReminder } from "./utterance.ts";

const COLLAPSED_LINES = 3;

type RenderTheme = {
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
};

type Ink = {
  rule(s: string): string;
  text(s: string): string;
  faint(s: string): string;
};

const TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const rgbOf = (ansi: string): Rgb | undefined => {
  const m = TRUECOLOR.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * Quiet editorial ink: today's OKLCH hue anchored to the theme's muted and foreground lightness.
 * Without truecolor, falls back cleanly to theme roles.
 */
function inkFor(theme: RenderTheme, at: Date): Ink {
  const muted = rgbOf(theme.getFgAnsi?.("muted") ?? theme.getFgAnsi?.("dim") ?? "");
  const text = rgbOf(theme.getFgAnsi?.("text") ?? "");
  if (!muted) {
    return {
      rule: (s) => theme.fg("borderMuted", s),
      text: (s) => theme.fg("muted", s),
      faint: (s) => theme.fg("dim", s),
    };
  }
  const mutedL = lightness(muted);
  const palette = dayPalette(mutedL, text ? lightness(text) : mutedL < 0.55 ? 0.22 : 0.89, dayHue(at));
  const paint = (rgb: Rgb) => (s: string) => `\x1b[38;2;${rgb.join(";")}m${s}\x1b[39m`;
  return {
    rule: paint(palette.rule),
    text: paint(palette.text),
    faint: paint(palette.faint),
  };
}

function renderBlock(block: string, contentWidth: number, pad: string, ink: Ink, expanded: boolean): string[] {
  const bar = `${pad}${ink.rule("│")} `;
  const emptyBar = `${pad}${ink.rule("│")}`;
  const foot = `${pad}${ink.rule("╵")} `;
  const wrapped: string[] = [];
  for (const line of block.split("\n")) {
    if (!line.trim()) {
      wrapped.push("");
      continue;
    }
    for (const vline of new Text(ink.text(line), 0, 0).render(contentWidth)) {
      wrapped.push(vline.trimEnd());
    }
  }
  const visible = expanded || wrapped.length <= COLLAPSED_LINES ? wrapped : wrapped.slice(0, COLLAPSED_LINES);
  const out = visible.map((line) => (line ? `${bar}${line}` : emptyBar));
  if (visible.length < wrapped.length) {
    const cue = `⋯ +${wrapped.length - visible.length} more`;
    out.push(`${foot}${truncateToWidth(ink.faint(cue), contentWidth, ink.faint("…"))}`);
  }
  return out;
}

export function registerPresenceUI(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(PRESENCE_ENTRY_TYPE, (entry, _options, theme) => {
    const text = dividerText(entry.data);
    return text === undefined ? undefined : new Text(theme.fg("dim", text), 0, 0);
  });
  pi.registerMessageRenderer?.(PERCEPTION_MESSAGE_TYPE, (message, options, theme) => {
    const details = message.details as { kind?: unknown; kinds?: unknown } | undefined;
    const storesRawText = isUtteranceKind(details?.kind)
      || (Array.isArray(details?.kinds) && details.kinds.length > 0 && details.kinds.every(isUtteranceKind));
    const rawBlocks = typeof message.content === "string"
      ? [message.content]
      : message.content.filter((block) => block.type === "text").map((block) => block.text);
    const blocks = rawBlocks
      .map((text) => (storesRawText ? text : unwrapReminder(text)).replace(/\r\n/g, "\n").trim())
      .filter(Boolean);
    if (!blocks.length) return undefined;
    const pad = " ".repeat((options.outputPad ?? 1) + 1);
    const at = new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now());
    return {
      invalidate() {},
      render(width: number): string[] {
        const ink = inkFor(theme, at);
        const contentWidth = Math.max(1, width - (pad.length + 2));
        const out: string[] = [];
        for (const block of blocks) {
          if (out.length) out.push("");
          out.push(...renderBlock(block, contentWidth, pad, ink, Boolean(options.expanded)));
        }
        return out;
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
