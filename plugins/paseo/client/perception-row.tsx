import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import type { PerceptionData } from "../shared/perception.ts";
import { dayHue, dayPalette, lightness, type Rgb } from "../shared/tint.ts";

const COLLAPSED_LINES = 3;

const hexRgb = (color: string): Rgb | undefined => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  return hex ? [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb : undefined;
};
const css = ([r, g, b]: Rgb, alpha = 1) => `rgba(${r},${g},${b},${alpha})`;

/** Same quiet editorial palette as the Pi TUI, calibrated to the active Paseo theme. */
function inkFor(theme: PluginTimelineItemProps["theme"], at: Date) {
  const muted = hexRgb(theme.colors.foregroundMuted);
  const fg = hexRgb(theme.colors.foreground);
  const surface = hexRgb(theme.colors.surface0);
  const dark = surface ? lightness(surface) < 0.5 : true;
  const mutedL = muted ? lightness(muted) : dark ? 0.67 : 0.47;
  const fgL = fg ? lightness(fg) : dark ? 0.92 : 0.24;
  const palette = dayPalette(mutedL, fgL, dayHue(at));
  return {
    rule: css(palette.rule, 0.5),
    text: css(palette.text),
  };
}

export function PerceptionRow({ item, theme, timestamp }: PluginTimelineItemProps<PerceptionData>) {
  const [expanded, setExpanded] = useState(false);
  const ink = inkFor(theme, timestamp);
  const bodyStyle: TextStyle = {
    color: ink.text,
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0.15,
  };
  return (
    <Pressable
      onPress={() => setExpanded((value) => !value)}
      accessibilityRole="button"
      accessibilityLabel={expanded ? "Collapse perception" : "Expand perception"}
      aria-expanded={expanded}
      style={({ pressed }) => ({ marginVertical: 8, opacity: pressed ? 0.78 : 1 })}
    >
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: ink.rule,
          paddingLeft: 12,
          marginLeft: 6,
          paddingVertical: 2,
        }}
      >
        <Text style={bodyStyle} numberOfLines={expanded ? undefined : COLLAPSED_LINES} selectable={expanded}>
          {item.data.text}
        </Text>
      </View>
    </Pressable>
  );
}
