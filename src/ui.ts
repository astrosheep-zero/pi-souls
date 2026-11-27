import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { PERCEPTION_MESSAGE_TYPE } from "./perception.ts";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";
import { lightness, oklch, timeHue, type Rgb } from "./tint.ts";
import { isUtteranceKind, unwrapReminder } from "./utterance.ts";

/** Collapsed preview: four lines, only folding when hiding more than one extra line (matches Paseo). */
const COLLAPSED_LINES = 4;
const FOLD_THRESHOLD = COLLAPSED_LINES + 1;

type RenderTheme = {
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
};

type Ink = {
  slit(glyph: string, weight: number, single: boolean): string;
  text(s: string): string;
  softText(s: string): string;
  fadeText(s: string): string;
  cue(s: string): string;
};

const TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const rgbOf = (ansi: string): Rgb | undefined => {
  const m = TRUECOLOR.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * Circadian mineral ink aligned with the Paseo optical filament: low-chroma OKLCH hue calibrated
 * to the theme's polarity and foreground/muted lightness, foreground-only (never paints terminal bg).
 */
function inkFor(theme: RenderTheme, at: Date): Ink {
  const muted = rgbOf(theme.getFgAnsi?.("muted") ?? theme.getFgAnsi?.("dim") ?? "");
  const text = rgbOf(theme.getFgAnsi?.("text") ?? "");
  if (!muted) {
    return {
      slit: (glyph, weight) => theme.fg(weight < 0.45 ? "dim" : "borderMuted", glyph),
      text: (s) => theme.fg("muted", s),
      softText: (s) => theme.fg("muted", s),
      fadeText: (s) => theme.fg("dim", s),
      cue: (s) => theme.fg("borderMuted", s),
    };
  }
  const mutedL = lightness(muted);
  const fgL = text ? lightness(text) : mutedL < 0.55 ? 0.22 : 0.89;
  const isDark = fgL > mutedL;
  const bgL = isDark ? 0.18 : 0.975;
  const clamp = (L: number) => Math.min(0.96, Math.max(0.12, L));

  const h = timeHue(at);
  // Lift gold/apricot angles (~56°) gently on light surfaces so they stay luminous rather than ochre.
  const goldDist = Math.abs((((h - 56) + 540) % 360) - 180);
  const warmLift = goldDist < 48 ? 0.5 + 0.5 * Math.cos((goldDist * Math.PI) / 48) : 0;
  // Tame electric cyan/cobalt/violet angles (~240°) to match the Paseo muted mineral palette.
  const coolDist = Math.abs((((h - 240) + 540) % 360) - 180);
  const coolTrim = coolDist < 90 ? 1 - 0.24 * (0.5 + 0.5 * Math.cos((coolDist * Math.PI) / 90)) : 1;

  const paint = (rgb: Rgb) => (s: string) => `\x1b[38;2;${rgb.join(";")}m${s}\x1b[39m`;
  const bodyL = clamp(isDark ? mutedL + (fgL - mutedL) * 0.26 : mutedL - (mutedL - fgL) * 0.22);
  const lerpBg = (t: number) => clamp(bgL + (bodyL - bgL) * t);

  return {
    slit: (glyph, weight, single) => {
      if (single) {
        return paint(oklch(
          isDark ? 0.86 : 0.61 + 0.075 * warmLift,
          (isDark ? 0.072 : 0.084) * coolTrim,
          h,
        ))(glyph);
      }
      if (isDark) {
        const tailL = bgL + 0.16;
        const L = tailL + (0.91 - tailL) * (0.22 + 0.78 * weight);
        const midBoost = Math.sin(Math.min(1, weight) * Math.PI);
        const C = (0.024 + 0.044 * weight + 0.020 * midBoost) * coolTrim;
        return paint(oklch(clamp(L), C, h))(glyph);
      }
      const tailL = bgL - 0.12;
      const peakL = 0.57 + 0.075 * warmLift;
      const L = tailL - (tailL - peakL) * (0.22 + 0.78 * weight);
      return paint(oklch(clamp(L), (0.026 + 0.062 * weight) * coolTrim, h))(glyph);
    },
    text: paint(oklch(bodyL, 0.005, h)),
    softText: paint(oklch(lerpBg(0.68), 0.005, h)),
    fadeText: paint(oklch(lerpBg(0.38), 0.004, h)),
    cue: paint(oklch(isDark ? 0.65 : 0.56 + 0.05 * warmLift, 0.050 * coolTrim, h)),
  };
}

function slitWeight(index: number, count: number): number {
  if (count <= 1) return 1;
  if (count === 2) return index === 0 ? 1 : 0.72;
  const peak = 1;
  if (index < peak) return 0.66;
  const t = (index - peak) / Math.max(1, count - 1 - peak);
  return Math.pow(1 - Math.min(1, t), 1.25);
}

function slitGlyph(index: number, count: number): string {
  if (count <= 1) return "│";
  if (index === 0) return "╷";
  if (index === count - 1) return "╵";
  return "│";
}

function renderBlock(block: string, contentWidth: number, lead: string, ink: Ink, expanded: boolean): string[] {
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
  const isLong = wrapped.length > FOLD_THRESHOLD;
  const visible = expanded || !isLong ? wrapped : wrapped.slice(0, COLLAPSED_LINES);
  while (!expanded && isLong && visible.length > 1 && visible.at(-1) === "") {
    visible.pop();
  }
  const n = visible.length;
  const out = visible.map((line, i) => {
    const bar = ink.slit(slitGlyph(i, n), slitWeight(i, n), n === 1);
    if (!line) return `${lead}${bar}`;
    const remain = n - 1 - i;
    const body = expanded || !isLong ? ink.text : remain === 0 ? ink.fadeText : remain === 1 ? ink.softText : ink.text;
    return `${lead}${bar} ${body(line)}`;
  });
  if (isLong) {
    out.push(`${lead}  ${ink.cue(expanded ? "⌃" : "⌄")}`);
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
    const lead = " ".repeat(options.outputPad ?? 1);
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
        const contentWidth = Math.max(1, width - lead.length - 2);
        const out: string[] = [];
        for (const block of blocks) {
          if (out.length) out.push("");
          out.push(...renderBlock(block, contentWidth, lead, ink, Boolean(options.expanded)));
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
