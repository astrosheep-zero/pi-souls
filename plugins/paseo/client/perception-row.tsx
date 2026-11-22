import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import type { PerceptionData } from "../shared/perception.ts";
import { dayHue, dayPalette, lightness, type Rgb } from "../shared/tint.ts";

const COLLAPSED_LINES = 3;
const LINE_HEIGHT = 19;
const MAX_DEPTH_SLOTS = 7;
const DEFAULT_CHARS_PER_LINE = 64;
const MIST_STEPS: readonly [height: number, alpha: number][] = [
  [5, 0.12],
  [5, 0.36],
  [6, 0.68],
  [6, 0.94],
];

const hexRgb = (color: string): Rgb | undefined => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  return hex ? ([0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb) : undefined;
};
const css = ([r, g, b]: Rgb, alpha = 1) => `rgba(${r},${g},${b},${alpha})`;

function estimateLines(text: string, charsPerLine: number): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      total += 1;
      continue;
    }
    let units = 0;
    for (const ch of line) units += ch.charCodeAt(0) > 0x7f ? 1.85 : 1;
    total += Math.max(1, Math.ceil(units / charsPerLine));
  }
  return total;
}

/** Index-tab editorial palette calibrated to the active Paseo theme and local day hue. */
function inkFor(theme: PluginTimelineItemProps["theme"], at: Date) {
  const bg = hexRgb(theme.colors.surface0) ?? [18, 18, 20];
  const muted = hexRgb(theme.colors.foregroundMuted) ?? [161, 161, 170];
  const fg = hexRgb(theme.colors.foreground) ?? [244, 244, 245];
  const palette = dayPalette(lightness(bg), lightness(muted), lightness(fg), dayHue(at));
  return {
    bg,
    tab: css(palette.tab),
    text: css(palette.text),
    softText: css(palette.softText),
    hair: css(palette.hair),
  };
}

export function PerceptionRow({ item, theme, timestamp }: PluginTimelineItemProps<PerceptionData>) {
  const [expanded, setExpanded] = useState(false);
  const [charsPerLine, setCharsPerLine] = useState(DEFAULT_CHARS_PER_LINE);
  const ink = inkFor(theme, timestamp);
  const estLines = estimateLines(item.data.text, charsPerLine);
  const isLong = estLines > COLLAPSED_LINES;
  const totalSlots = Math.min(MAX_DEPTH_SLOTS, Math.max(2, Math.ceil(estLines / COLLAPSED_LINES)));
  const litSlots = expanded ? totalSlots : 1;

  const handleBodyLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) {
      const next = Math.max(24, Math.floor(width / 7.5));
      setCharsPerLine((prev) => (Math.abs(prev - next) >= 4 ? next : prev));
    }
  };

  return (
    <Pressable
      onPress={isLong ? () => setExpanded((value) => !value) : undefined}
      accessibilityRole={isLong ? "button" : undefined}
      accessibilityLabel={isLong ? (expanded ? "Collapse perception" : "Expand perception") : undefined}
      aria-expanded={isLong ? expanded : undefined}
      style={({ pressed }) => ({
        marginVertical: 2,
        opacity: isLong && pressed ? 0.78 : 1,
      })}
    >
      <View onLayout={handleBodyLayout}>
        <View
          style={
            isLong && !expanded
              ? { position: "relative", maxHeight: COLLAPSED_LINES * LINE_HEIGHT, overflow: "hidden" }
              : undefined
          }
        >
          <Text
            style={{
              color: expanded ? ink.text : ink.softText,
              fontSize: 13,
              lineHeight: LINE_HEIGHT,
              letterSpacing: 0.1,
            }}
            selectable={expanded}
          >
            {item.data.text}
          </Text>
          {isLong && !expanded ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
              {MIST_STEPS.map(([height, alpha], i) => (
                <View key={i} style={{ height, backgroundColor: css(ink.bg, alpha) }} />
              ))}
            </View>
          ) : null}
        </View>
        {isLong ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: expanded ? 8 : 5 }}>
            {Array.from({ length: totalSlots }).map((_, i) => (
              <View
                key={i}
                style={{
                  width: 13,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: i < litSlots ? ink.tab : ink.hair,
                  opacity: i < litSlots ? 0.92 : 0.45,
                }}
              />
            ))}
            {expanded ? (
              <Text style={{ color: ink.tab, opacity: 0.78, fontSize: 10.5, marginLeft: 4 }}>▴</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
