import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState, type ReactNode } from "react";
import { Pressable, Text, type TextStyle } from "react-native";
import type { PerceptionData } from "../shared/perception.ts";
import { DAY_CHROMA, dayHue, lightness, oklch, type Rgb } from "../shared/tint.ts";

const hexRgb = (color: string): Rgb | undefined => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  return hex ? [0, 2, 4].map(at => parseInt(hex.slice(at, at + 2), 16)) as Rgb : undefined;
};
const css = ([r, g, b]: Rgb, alpha = 1) => `rgba(${r},${g},${b},${alpha})`;

/** Unwrap theatre bracket thoughts and keep the soul's own line breaks. */
const linesOf = (text: string) =>
  text.replace(/``\s*(\[[^\]]*\])\s*``/g, "$1").replace(/\*([^*\n]+)\*/g, "$1")
    .split("\n").map(line => line.trim()).filter(Boolean);

/**
 * Same ink as the TUI: the muted colour's lightness, today's hue at a chroma too low to name.
 * Brackets and quotes step back towards the surface; nothing else is styled.
 */
function inkFor(theme: PluginTimelineItemProps["theme"], at: Date) {
  const muted = hexRgb(theme.colors.foregroundMuted), fg = hexRgb(theme.colors.foreground);
  const surface = hexRgb(theme.colors.surface0);
  const dark = surface ? lightness(surface) < 0.5 : false;
  const L = muted ? lightness(muted) : dark ? 0.665 : 0.585;
  const faintL = L + (L - (fg ? lightness(fg) : 1 - L)) * 0.35;
  const hue = dayHue(at);
  return {
    dark, hue,
    text: muted ? css(oklch(L, DAY_CHROMA, hue)) : theme.colors.foregroundMuted,
    faint: css(oklch(faintL, DAY_CHROMA, hue)),
  };
}

export function PerceptionRow({ item, theme, timestamp }: PluginTimelineItemProps<PerceptionData>) {
  const [expanded, setExpanded] = useState(false);
  const ink = inkFor(theme, timestamp);
  const lines = linesOf(item.data.text);
  const spans = (line: string, key: string): ReactNode[] =>
    line.split(/([\[\]“”"])/g).filter(Boolean).map((part, i) =>
      /^[\[\]“”"]$/.test(part) ? <Text key={`${key}-${i}`} style={{ color: ink.faint }}>{part}</Text> : part);
  // No rule, no box: an indent and the day's ink set it apart from the reply.
  const style: TextStyle = {
    color: ink.text, fontSize: 13, lineHeight: 20, letterSpacing: 0.2,
    marginVertical: 9, marginLeft: 14,
    ...(ink.dark ? { textShadowColor: css(oklch(0.7, 0.02, ink.hue), 0.06), textShadowRadius: 4 } : {}),
  };
  return <Pressable onPress={() => setExpanded(value => !value)} accessibilityRole="button" aria-expanded={expanded}>
    <Text style={style} numberOfLines={expanded ? undefined : 2} selectable={expanded}>
      {lines.flatMap((line, i) => [i > 0 ? "\n" : null, ...spans(line, String(i))])}
    </Text>
  </Pressable>;
}
