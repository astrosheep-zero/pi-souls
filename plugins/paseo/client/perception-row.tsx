import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { compactPerceptionLines, type PerceptionData } from "../shared/perception.ts";

function renderStyledSpans(line: string, mutedColor: string, keyPrefix: string): ReactNode[] {
  const parts = line.split(/(\[[^\]]+\]|\*[^*\n]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("[") && part.endsWith("]")) {
      return (
        <Text key={key} style={{ color: mutedColor, fontWeight: "500" }}>
          {part}
        </Text>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <Text key={key} style={{ color: mutedColor, fontStyle: "italic", opacity: 0.85 }}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return (
      <Text key={key} style={{ color: mutedColor, opacity: 0.85 }}>
        {part}
      </Text>
    );
  });
}

export function PerceptionRow({ item, theme }: PluginTimelineItemProps<PerceptionData>) {
  const [expanded, setExpanded] = useState(false);
  const lines = compactPerceptionLines(item.data.text);
  const collapsible = lines.length > 2 || item.data.text.length > 160;
  const muted = theme.colors.foregroundMuted;
  const guide = {
    borderLeftWidth: 1.5,
    borderLeftColor: theme.colors.border,
    paddingLeft: 9,
  };

  if (!collapsible) {
    return (
      <View style={{ paddingVertical: 2 }}>
        <View style={{ ...guide, gap: 2 }}>
          {lines.map((line, index) => (
            <Text key={index} selectable style={{ color: muted, fontSize: 12.5, lineHeight: 18 }}>
              {renderStyledSpans(line, muted, `line-${index}`)}
            </Text>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={{ paddingVertical: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Collapse perception" : "Expand perception"}
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
          <View style={{ ...guide, flex: 1, gap: 3 }}>
            {!expanded ? (
              <Text numberOfLines={2} style={{ color: muted, fontSize: 12.5, lineHeight: 18 }}>
                {lines.map((line, index) => [
                  index > 0 ? "\n" : null,
                  ...renderStyledSpans(line, muted, `fold-${index}`),
                ])}
              </Text>
            ) : (
              lines.map((line, index) => (
                <Text key={index} selectable style={{ color: muted, fontSize: 12.5, lineHeight: 18 }}>
                  {renderStyledSpans(line, muted, `exp-${index}`)}
                </Text>
              ))
            )}
          </View>
          <View style={{ paddingTop: 3 }}>
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={10} color={muted} />
          </View>
        </View>
      </Pressable>
    </View>
  );
}
