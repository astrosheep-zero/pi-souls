import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Platform, Pressable, Text, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import type { PerceptionData } from "../shared/perception.ts";
import { lightness, oklch, timeHue, type Rgb } from "../shared/tint.ts";

const COLLAPSED_LINES = 4;
const LINE_HEIGHT = 20;
const COLLAPSED_HEIGHT = COLLAPSED_LINES * LINE_HEIGHT;
const DEFAULT_CHARS_PER_LINE = 42;

const hexRgb = (color: string): Rgb | undefined => {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  return hex ? ([0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb) : undefined;
};
const css = ([r, g, b]: Rgb, alpha = 1) => `rgba(${r},${g},${b},${alpha})`;

/** Native-parity gradient style: iOS/Android Fabric (`experimental_backgroundImage`) + Web (`backgroundImage`). */
const bgGradient = (value: string): ViewStyle =>
  (Platform.OS === "web"
    ? { backgroundImage: value }
    : { experimental_backgroundImage: value }) as ViewStyle;

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

function focalGeometry(lines: number) {
  if (lines <= 1) return { top: 5.5, h: 19, bloomTop: -0.5, bloomH: 31, spillTop: -5, spillH: 40, rightW: 172 };
  if (lines === 2) return { top: 6, h: 38, bloomTop: -1, bloomH: 52, spillTop: -5, spillH: 60, rightW: 196 };
  if (lines === 3) return { top: 5.5, h: 55, bloomTop: -1.5, bloomH: 69, spillTop: -6, spillH: 78, rightW: 208 };
  return { top: 5, h: 66, bloomTop: -2, bloomH: 80, spillTop: -6, spillH: 90, rightW: 218 };
}

function opticsFor(theme: PluginTimelineItemProps["theme"], at: Date) {
  const bg = hexRgb(theme.colors.surface0) ?? [18, 18, 20];
  const muted = hexRgb(theme.colors.foregroundMuted) ?? [161, 161, 170];
  const fg = hexRgb(theme.colors.foreground) ?? [244, 244, 245];
  const bgL = lightness(bg);
  const mutedL = lightness(muted);
  const fgL = lightness(fg);
  const isDark = fgL > bgL;
  const h = timeHue(at);
  const clamp = (L: number) => Math.min(0.97, Math.max(0.10, L));
  // Gold/apricot angles (around 56°) turn ochre if forced to L=0.68 on light surfaces; lift gently.
  const goldDist = Math.abs((((h - 56) + 540) % 360) - 180);
  const warmLift = goldDist < 48 ? 0.5 + 0.5 * Math.cos((goldDist * Math.PI) / 48) : 0;

  const core = oklch(isDark ? 0.90 : 0.67 + 0.09 * warmLift, isDark ? 0.085 : 0.165, h);
  const aura = oklch(isDark ? 0.78 : 0.75 + 0.07 * warmLift, isDark ? 0.14 : 0.145, h);
  const spill = oklch(isDark ? 0.75 : 0.81 + 0.05 * warmLift, isDark ? 0.12 : 0.12, h);
  const text = oklch(clamp(isDark ? mutedL + (fgL - mutedL) * 0.42 : mutedL - (mutedL - fgL) * 0.28), 0.008, h);
  const softText = oklch(clamp(isDark ? mutedL + (fgL - mutedL) * 0.26 : mutedL - (mutedL - fgL) * 0.12), 0.008, h);
  const cue = oklch(isDark ? 0.79 : 0.54 + 0.06 * warmLift, 0.085, h);
  return { bg, isDark, core, aura, spill, text: css(text), softText: css(softText), cue };
}

function MistFade({ bg }: { bg: Rgb }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 28,
        ...bgGradient(
          `linear-gradient(180deg, ${css(bg, 0)} 0%, ${css(bg, 0.10)} 28%, ${css(bg, 0.42)} 62%, ${css(bg, 0.82)} 88%, ${css(bg, 1)} 100%)`,
        ),
      }}
    />
  );
}

function MicroChevron({ color, expanded }: { color: string; expanded: boolean }) {
  return (
    <View style={{ width: 9, height: 10, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: 5,
          height: 5,
          borderRightWidth: 1.25,
          borderBottomWidth: 1.25,
          borderColor: color,
          transform: [{ rotate: expanded ? "-135deg" : "45deg" }, { translateY: expanded ? 1.5 : -1.5 }],
        }}
      />
    </View>
  );
}

/** Single-source asymmetric radiance anchored on the aperture axis (x = 7px) with zero edge clipping. */
function AsymmetricSpill({
  color,
  peak,
  top,
  height,
  rightW,
}: {
  color: Rgb;
  peak: number;
  top: number;
  height: number;
  rightW: number;
}) {
  const stops = `${css(color, peak)} 0%, ${css(color, peak * 0.48)} 32%, ${css(color, peak * 0.14)} 68%, ${css(color, 0)} 100%`;
  return (
    <>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: -8,
          top,
          width: 15,
          height,
          ...bgGradient(`radial-gradient(ellipse 100% 50% at 100% 50%, ${stops})`),
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 7,
          top,
          width: rightW,
          height,
          ...bgGradient(`radial-gradient(ellipse 100% 50% at 0% 50%, ${stops})`),
        }}
      />
    </>
  );
}

export function PerceptionRow({ item, theme, timestamp }: PluginTimelineItemProps<PerceptionData>) {
  const [expanded, setExpanded] = useState(false);
  const [charsPerLine, setCharsPerLine] = useState(DEFAULT_CHARS_PER_LINE);
  const at = item.data.at === undefined ? timestamp : new Date(item.data.at);
  const o = opticsFor(theme, at);
  const lines = estimateLines(item.data.text, charsPerLine);
  const isLong = lines > COLLAPSED_LINES;
  const collapsed = isLong && !expanded;
  const g = focalGeometry(lines);

  const handleBodyLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) {
      const next = Math.max(20, Math.floor(width / 7.5));
      setCharsPerLine((prev) => (Math.abs(prev - next) >= 4 ? next : prev));
    }
  };

  const slitFilament = bgGradient(
    `radial-gradient(ellipse closest-side at 50% 50%, ${css(o.core, o.isDark ? 0.84 : 0.82)} 0%, ${css(o.core, o.isDark ? 0.56 : 0.54)} 38%, ${css(o.aura, o.isDark ? 0.21 : 0.19)} 74%, ${css(o.aura, 0)} 100%)`,
  );
  const innerBloom = bgGradient(
    `radial-gradient(ellipse closest-side at 50% 50%, ${css(o.aura, o.isDark ? 0.24 : 0.19)} 0%, ${css(o.aura, o.isDark ? 0.092 : 0.072)} 46%, ${css(o.aura, o.isDark ? 0.022 : 0.017)} 76%, ${css(o.aura, 0)} 100%)`,
  );

  return (
    <Pressable
      onPress={isLong ? () => setExpanded((value) => !value) : undefined}
      accessibilityRole={isLong ? "button" : undefined}
      accessibilityLabel={isLong ? (expanded ? "Collapse perception" : "Expand perception") : undefined}
      aria-expanded={isLong ? expanded : undefined}
      style={({ pressed }) => ({
        marginVertical: 2,
        paddingVertical: 5,
        paddingLeft: 23,
        paddingRight: 4,
        position: "relative",
        opacity: isLong && pressed ? 0.78 : 1,
      })}
    >
      <AsymmetricSpill
        color={o.spill}
        peak={o.isDark ? 0.115 : 0.098}
        top={g.spillTop}
        height={g.spillH}
        rightW={g.rightW}
      />
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: -1, top: g.bloomTop, width: 16, height: g.bloomH, ...innerBloom }}
      />
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 5.75, top: g.top, width: 2.5, height: g.h, ...slitFilament }}
      />
      <View onLayout={handleBodyLayout}>
        <View
          style={
            collapsed
              ? { position: "relative", maxHeight: COLLAPSED_HEIGHT, overflow: "hidden" }
              : undefined
          }
        >
          <Text
            style={{
              color: collapsed ? o.softText : o.text,
              fontSize: 13,
              lineHeight: LINE_HEIGHT,
              letterSpacing: 0.12,
              fontVariant: ["tabular-nums"],
            }}
            selectable={expanded}
          >
            {item.data.text}
          </Text>
          {collapsed ? <MistFade bg={o.bg} /> : null}
        </View>
        {isLong ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: expanded ? 4 : 1, marginLeft: 0.5 }}>
            <MicroChevron color={css(o.cue, o.isDark ? 0.66 : 0.70)} expanded={expanded} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
