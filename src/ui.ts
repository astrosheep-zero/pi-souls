import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { PERCEPTION_MESSAGE_TYPE } from "./perception.ts";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";
import { dayHue, dayPalette, lightness, type Rgb } from "./tint.ts";
import { isUtteranceKind, unwrapReminder } from "./utterance.ts";

const COLLAPSED_LINES = 3;
const MAX_DEPTH_SLOTS = 7;

type RenderTheme = {
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
};

type Ink = {
  tab(s: string): string;
  text(s: string): string;
  softText(s: string): string;
  hair(s: string): string;
  faint(s: string): string;
};

const TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const rgbOf = (ansi: string): Rgb | undefined => {
  const m = TRUECOLOR.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * Index-tab editorial ink: today's OKLCH hue calibrated to the theme's muted and foreground
 * lightness. Falls back cleanly to theme roles when truecolor ANSI is unavailable.
 */
function inkFor(theme: RenderTheme, at: Date): Ink {
  const muted = rgbOf(theme.getFgAnsi?.("muted") ?? theme.getFgAnsi?.("dim") ?? "");
  const text = rgbOf(theme.getFgAnsi?.("text") ?? "");
  if (!muted) {
    return {
      tab: (s) => theme.fg("borderMuted", s),
      text: (s) => theme.fg("muted", s),
      softText: (s) => theme.fg("muted", s),
      hair: (s) => theme.fg("dim", s),
      faint: (s) => theme.fg("dim", s),
    };
  }
  const mutedL = lightness(muted);
  const textL = text ? lightness(text) : mutedL < 0.55 ? 0.22 : 0.89;
  const bgL = textL > mutedL ? 0.19 : 0.98;
  const palette = dayPalette(bgL, mutedL, textL, dayHue(at));
  const paint = (rgb: Rgb) => (s: string) => `\x1b[38;2;${rgb.join(";")}m${s}\x1b[39m`;
  return {
    tab: paint(palette.tab),
    text: paint(palette.text),
    softText: paint(palette.softText),
    hair: paint(palette.hair),
    faint: paint(palette.faint),
  };
}

function renderBlock(block: string, contentWidth: number, pad: string, ink: Ink, expanded: boolean): string[] {
  const wrapped: string[] = [];
  for (const line of block.split("\n")) {
    if (!line.trim()) {
      wrapped.push("");
      continue;
    }
    for (const vline of new Text(line, 0, 0).render(contentWidth)) {
      wrapped.push(vline.trimEnd());
    }
  }
  const isLong = wrapped.length > COLLAPSED_LINES;
  const visible = expanded || !isLong ? wrapped : wrapped.slice(0, COLLAPSED_LINES);
  const body = expanded ? ink.text : ink.softText;
  const out = visible.map((line, i) => {
    const marker = i === 0 ? ink.tab("┃") : isLong && i % 2 === 1 ? ink.hair("·") : " ";
    if (!line) return marker === " " ? "" : `${pad}${marker}`;
    return `${pad}${marker} ${body(line)}`;
  });
  if (isLong) {
    const totalSlots = Math.min(MAX_DEPTH_SLOTS, Math.max(2, Math.ceil(wrapped.length / COLLAPSED_LINES)));
    const litSlots = expanded ? totalSlots : 1;
    const gauge = `${ink.tab("━".repeat(litSlots * 2))}${ink.hair("─".repeat((totalSlots - litSlots) * 2))}${expanded ? ink.faint(" ▴") : ""}`;
    out.push(`${pad}  ${truncateToWidth(gauge, contentWidth, "")}`);
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
