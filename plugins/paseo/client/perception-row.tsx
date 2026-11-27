import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import type { PerceptionData } from "../shared/perception.ts";
import { lightness, oklch, timeHue, type Rgb } from "../shared/tint.ts";

const LINE_HEIGHT = 20;
const PARAGRAPH_GAP = 6;
/** Collapsed preview: four lines, but only when folding hides more than one extra line. */
const COLLAPSED_HEIGHT = 4 * LINE_HEIGHT;
const FOLD_THRESHOLD = COLLAPSED_HEIGHT + LINE_HEIGHT;
/** Native tool rows are 32px; one perception line (20px) plus 6px above and below matches them. */
const ROW_PAD_Y = 6;

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

/** Head light sized to the first (up to four) visible lines; taller bodies keep the same source. */
function focalGeometry(visibleHeight: number) {
  const lines = Math.max(1, Math.min(4, Math.round(visibleHeight / LINE_HEIGHT)));
  if (lines === 1) return { peakY: 10, bloomTop: 15, bloomBot: 17, spillTop: 19, spillBot: 22, rightW: 184 };
  if (lines === 2) return { peakY: 18, bloomTop: 22, bloomBot: 30, spillTop: 26, spillBot: 36, rightW: 210 };
  if (lines === 3) return { peakY: 23, bloomTop: 27, bloomBot: 44, spillTop: 31, spillBot: 50, rightW: 224 };
  return { peakY: 23, bloomTop: 28, bloomBot: 56, spillTop: 32, spillBot: 64, rightW: 238 };
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

  // Cyan/cobalt/violet angles read more electric than warm hues at equal OKLCH chroma; tame them gently.
  const coolDist = Math.abs((((h - 240) + 540) % 360) - 180);
  const coolTrim = coolDist < 90 ? 1 - 0.24 * (0.5 + 0.5 * Math.cos((coolDist * Math.PI) / 90)) : 1;

  const hot = oklch(isDark ? 0.955 : 0.78 + 0.06 * warmLift, (isDark ? 0.016 : 0.054) * coolTrim, h);
  const core = oklch(isDark ? 0.875 : 0.63 + 0.08 * warmLift, (isDark ? 0.048 : 0.084) * coolTrim, h);
  const aura = oklch(isDark ? 0.75 : 0.74 + 0.06 * warmLift, (isDark ? 0.082 : 0.078) * coolTrim, h);
  const spill = oklch(isDark ? 0.72 : 0.81 + 0.04 * warmLift, (isDark ? 0.070 : 0.072) * coolTrim, h);
  const text = oklch(clamp(isDark ? mutedL + (fgL - mutedL) * 0.42 : mutedL - (mutedL - fgL) * 0.28), 0.005, h);
  const cue = oklch(isDark ? 0.77 : 0.54 + 0.05 * warmLift, 0.050 * coolTrim, h);
  return { bg, isDark, hot, core, aura, spill, text: css(text), cue };
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
        height: 40,
        ...bgGradient(
          `linear-gradient(180deg, ${css(bg, 0)} 0%, ${css(bg, 0.08)} 24%, ${css(bg, 0.34)} 50%, ${css(bg, 0.72)} 74%, ${css(bg, 0.94)} 90%, ${css(bg, 1)} 100%)`,
        ),
      }}
    />
  );
}

function MicroChevron({ color, progress }: { color: string; progress: Animated.Value }) {
  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["45deg", "-135deg"] });
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-1.5, 1.5] });
  return (
    <View style={{ width: 9, height: 10, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          width: 5,
          height: 5,
          borderRightWidth: 1.25,
          borderBottomWidth: 1.25,
          borderBottomRightRadius: 0.75,
          borderColor: color,
          transform: [{ translateY }, { rotate }],
        }}
      />
    </View>
  );
}

/** Single-source asymmetric 2D radiance anchored on `(7, cy)` — zero seams, zero hard edges. */
function AsymmetricSpill({
  color,
  peak,
  cy,
  topH,
  botH,
  rightW,
}: {
  color: Rgb;
  peak: number;
  cy: number;
  topH: number;
  botH: number;
  rightW: number;
}) {
  const stops = `${css(color, peak)} 0%, ${css(color, peak * 0.46)} 30%, ${css(color, peak * 0.14)} 64%, ${css(color, peak * 0.03)} 86%, ${css(color, 0)} 100%`;
  return (
    <>
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: -8, top: cy - topH, width: 15, height: topH, ...bgGradient(`radial-gradient(ellipse 100% 100% at 100% 100%, ${stops})`) }}
      />
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 7, top: cy - topH, width: rightW, height: topH, ...bgGradient(`radial-gradient(ellipse 100% 100% at 0% 100%, ${stops})`) }}
      />
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: -8, top: cy, width: 15, height: botH, ...bgGradient(`radial-gradient(ellipse 100% 100% at 100% 0%, ${stops})`) }}
      />
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 7, top: cy, width: rightW, height: botH, ...bgGradient(`radial-gradient(ellipse 100% 100% at 0% 0%, ${stops})`) }}
      />
    </>
  );
}

/** C1-continuous two-half vertical ellipse centered horizontally at `x = 7` and vertically at `cy`. */
function TaperedEllipse({
  width,
  cy,
  topH,
  botH,
  stops,
}: {
  width: number;
  cy: number;
  topH: number;
  botH: number | Animated.AnimatedInterpolation<number>;
  stops: string;
}) {
  const left = 7 - width / 2;
  return (
    <>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left,
          top: cy - topH,
          width,
          height: topH,
          ...bgGradient(`radial-gradient(ellipse 50% 100% at 50% 100%, ${stops})`),
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left,
          top: cy,
          width,
          height: botH,
          ...bgGradient(`radial-gradient(ellipse 50% 100% at 50% 0%, ${stops})`),
        }}
      />
    </>
  );
}

/** Bottom edge of the fourth rendered line, so the fold never slices a line or lands in a paragraph gap. */
function foldLine(heights: number[]): number {
  let top = 0;
  let seen = 0;
  for (const height of heights) {
    const lines = Math.max(1, Math.round(height / LINE_HEIGHT));
    if (seen + lines >= 4) return top + (4 - seen) * LINE_HEIGHT;
    seen += lines;
    top += height + PARAGRAPH_GAP;
  }
  return COLLAPSED_HEIGHT;
}

function Paragraphs({
  paragraphs,
  color,
  selectable,
  onParagraphLayout,
}: {
  paragraphs: string[];
  color: string;
  selectable: boolean;
  onParagraphLayout?: (index: number, height: number) => void;
}) {
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <Text
          key={index}
          selectable={selectable}
          onLayout={onParagraphLayout ? (event) => onParagraphLayout(index, event.nativeEvent.layout.height) : undefined}
          style={{
            color,
            fontSize: 13,
            lineHeight: LINE_HEIGHT,
            letterSpacing: 0.12,
            fontVariant: ["tabular-nums"],
            marginTop: index === 0 ? 0 : PARAGRAPH_GAP,
          }}
        >
          {paragraph}
        </Text>
      ))}
    </>
  );
}

export function PerceptionRow({ item, theme, timestamp }: PluginTimelineItemProps<PerceptionData>) {
  const [expanded, setExpanded] = useState(false);
  const at = item.data.at === undefined ? timestamp : new Date(item.data.at);
  const o = opticsFor(theme, at);
  const paragraphs = item.data.text.split(/\n[ \t]*\n+/);
  const [heights, setHeights] = useState<number[]>([]);
  const measured = heights.length === paragraphs.length && heights.every((h) => h > 0);
  const fullHeight = measured ? heights.reduce((sum, h) => sum + h, 0) + PARAGRAPH_GAP * (heights.length - 1) : undefined;
  const isLong = fullHeight !== undefined && fullHeight > FOLD_THRESHOLD;
  const fold = isLong ? foldLine(heights) : 0;
  // Until measured, rest at the fold threshold so a long body never flashes at full height.
  const resting = fullHeight === undefined ? FOLD_THRESHOLD : isLong ? (expanded ? fullHeight : fold) : fullHeight;
  const g = focalGeometry(resting);
  const progress = useRef(new Animated.Value(0)).current;
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    Animated.timing(progress, {
      toValue: next ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  };
  const between = (from: number, to: number) => progress.interpolate({ inputRange: [0, 1], outputRange: [from, to] });

  // The measurer is absolutely positioned and independent of fold state, so it cannot feed back into layout.
  const handleParagraphLayout = (index: number, height: number) => {
    const rounded = Math.round(height);
    setHeights((prev) => {
      if (prev[index] === rounded && prev.length === paragraphs.length) return prev;
      const next = Array.from({ length: paragraphs.length }, (_, i) => prev[i] ?? 0);
      next[index] = rounded;
      return next;
    });
  };

  const inset = resting <= LINE_HEIGHT ? 0.5 : resting <= 3 * LINE_HEIGHT ? 1 : 2;
  const lightTop = ROW_PAD_Y;
  const cy = lightTop + g.peakY;
  const slitTopH = Math.max(4, cy - (lightTop + inset));
  const foldTail = Math.max(4, lightTop + fold - inset - cy);
  const fullTail = Math.max(4, lightTop + (fullHeight ?? fold) - inset - cy);
  const shortTail = Math.max(4, lightTop + resting - inset - cy);
  const sheathBotH = isLong ? between(foldTail, fullTail) : shortTail;
  const coreTopH = Math.max(4, Math.round(slitTopH * 0.86));
  const coreBotH = isLong
    ? between(Math.max(4, Math.round(foldTail * 0.72)), Math.max(4, Math.round(fullTail * 0.64)))
    : Math.max(4, Math.round(shortTail * 0.86));

  const bloomStops = `${css(o.aura, o.isDark ? 0.26 : 0.235)} 0%, ${css(o.aura, o.isDark ? 0.10 : 0.082)} 42%, ${css(o.aura, o.isDark ? 0.024 : 0.022)} 74%, ${css(o.aura, 0)} 100%`;
  const sheathStops = `${css(o.hot, o.isDark ? 0.48 : 0.44)} 0%, ${css(o.core, o.isDark ? 0.35 : 0.32)} 26%, ${css(o.aura, o.isDark ? 0.15 : 0.14)} 58%, ${css(o.aura, o.isDark ? 0.09 : 0.08)} 82%, ${css(o.aura, 0)} 100%`;
  const coreStops = `${css(o.hot, o.isDark ? 0.95 : 0.88)} 0%, ${css(o.core, o.isDark ? 0.60 : 0.56)} 36%, ${css(o.aura, o.isDark ? 0.16 : 0.14)} 74%, ${css(o.aura, 0)} 100%`;

  return (
    <Pressable
      onPress={isLong ? toggle : undefined}
      accessibilityRole={isLong ? "button" : undefined}
      accessibilityLabel={isLong ? (expanded ? "Collapse perception" : "Expand perception") : undefined}
      aria-expanded={isLong ? expanded : undefined}
      style={({ pressed }) => ({
        paddingVertical: ROW_PAD_Y,
        paddingLeft: 22.5,
        paddingRight: 4,
        position: "relative",
        opacity: isLong && pressed ? 0.78 : 1,
      })}
    >
      <AsymmetricSpill
        color={o.spill}
        peak={o.isDark ? 0.128 : 0.138}
        cy={cy}
        topH={g.spillTop}
        botH={g.spillBot}
        rightW={g.rightW}
      />
      <TaperedEllipse width={18} cy={cy} topH={g.bloomTop} botH={g.bloomBot} stops={bloomStops} />
      <TaperedEllipse width={3.5} cy={cy} topH={slitTopH} botH={sheathBotH} stops={sheathStops} />
      <TaperedEllipse width={1.4} cy={cy} topH={coreTopH} botH={coreBotH} stops={coreStops} />
      <View>
        <View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }}
        >
          <Paragraphs paragraphs={paragraphs} color="transparent" selectable={false} onParagraphLayout={handleParagraphLayout} />
        </View>
        <Animated.View
          style={
            isLong
              ? { maxHeight: between(fold, fullHeight ?? fold), overflow: "hidden" }
              : fullHeight === undefined
                ? { maxHeight: FOLD_THRESHOLD, overflow: "hidden" }
                : undefined
          }
        >
          <Paragraphs paragraphs={paragraphs} color={o.text} selectable={expanded || !isLong} />
          {isLong ? (
            <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: 0, opacity: between(1, 0) }}>
              <MistFade bg={o.bg} />
            </Animated.View>
          ) : null}
        </Animated.View>
        {isLong ? (
          // Collapsed, the chevron sits inside the bottom of the mist; expanded, it trails the last line.
          <Animated.View style={{ height: 12, justifyContent: "flex-end", marginLeft: 0.5, marginTop: between(-5, 2) }}>
            <MicroChevron color={css(o.cue, o.isDark ? 0.62 : 0.66)} progress={progress} />
          </Animated.View>
        ) : null}
      </View>
    </Pressable>
  );
}
