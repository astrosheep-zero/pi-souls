import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { PERCEPTION_MESSAGE_TYPE } from "./perception.ts";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";
import { lightness, oklch, timeHue, type Rgb } from "./tint.ts";
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
  fadeText(s: string): string;
  hair(s: string): string;
};

const TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const rgbOf = (ansi: string): Rgb | undefined => {
  const m = TRUECOLOR.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * Circadian editorial ink: local-time OKLCH hue calibrated to the theme's muted and foreground
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
      fadeText: (s) => theme.fg("dim", s),
      hair: (s) => theme.fg("dim", s),
    };
  }
  const mutedL = lightness(muted);
  const textL = text ? lightness(text) : mutedL < 0.55 ? 0.22 : 0.89;
  const bgL = textL > mutedL ? 0.19 : 0.98;
  const clampL = (L: number) => Math.min(0.95, Math.max(0.12, L));
  const lerp = (t: number) => clampL(bgL + (mutedL - bgL) * t);
  const hue = timeHue(at);
  const paint = (rgb: Rgb) => (s: string) => `\x1b[38;2;${rgb.join(";")}m${s}\x1b[39m`;
  return {
    tab: paint(oklch(clampL(mutedL + (textL - mutedL) * 0.10), 0.068, hue)),
    text: paint(oklch(clampL(mutedL + (textL - mutedL) * 0.14), 0.011, hue)),
    softText: paint(oklch(lerp(0.86), 0.011, hue)),
    fadeText: paint(oklch(lerp(0.46), 0.010, hue)),
    hair: paint(oklch(lerp(0.46), 0.028, hue)),
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
  const fade = [ink.text, ink.softText, ink.fadeText];
  const out = visible.map((line, i) => {
    const body = expanded || !isLong ? ink.text : fade[Math.min(i, fade.length - 1)]!;
    return line ? `${pad}${body(line)}` : "";
  });
  if (isLong) {
    const totalSlots = Math.min(MAX_DEPTH_SLOTS, Math.max(2, Math.ceil(wrapped.length / COLLAPSED_LINES)));
    const litSlots = expanded ? totalSlots : 1;
    const gauge = `${ink.tab("━".repeat(litSlots * 2))}${ink.hair("─".repeat((totalSlots - litSlots) * 2))}${expanded ? ink.tab(" ▴") : ""}`;
    out.push(`${pad}${truncateToWidth(gauge, contentWidth, "")}`);
  }
  return out;
}

export function registerPresenceUI(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(PRESENCE_ENTRY_TYPE, (entry, _options, theme) => {
    const text = dividerText(entry.data);
    return text === undefined ? undefined : new Text(theme.fg("dim", text), 0, 0);
  });
  pi.registerMessageRenderer?.(PERCEPTION_MESSAGE_TYPE, (message, options, theme) => {
    const details = message.details as { kind?: unknown; kinds?: unknown; timestamp?: unknown } | undefined;
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
    const ts = typeof details?.timestamp === "number" && Number.isFinite(details.timestamp)
      ? details.timestamp
      : typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : Date.now();
    const at = new Date(ts);
    return {
      invalidate() {},
      render(width: number): string[] {
        const ink = inkFor(theme, at);
        const contentWidth = Math.max(1, width - pad.length);
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
