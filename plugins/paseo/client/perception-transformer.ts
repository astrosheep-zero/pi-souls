import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PERCEPTION_KIND, PERCEPTION_MESSAGE_TYPE, unwrapReminder } from "../shared/perception.ts";

type Transformer = Extract<Parameters<PluginClientContext["addTimelineTransformer"]>[0], { query: { itemType: "tool_call" } }>;
type Source = Parameters<Transformer["transform"]>[0];

export const perceptionTransformer = {
  id: "pi-souls-perception",
  query: { itemType: "tool_call" },
  transform: ({ item }: Pick<Source, "item">) => {
    if (
      item.type !== "tool_call" ||
      item.metadata?.customType !== PERCEPTION_MESSAGE_TYPE ||
      item.detail?.type !== "plain_text" ||
      typeof item.detail.text !== "string"
    ) {
      return undefined;
    }
    const text = unwrapReminder(item.detail.text).trim();
    if (!text) return undefined;
    return {
      items: [{
        type: "plugin" as const,
        kind: PERCEPTION_KIND,
        version: 1,
        data: { text },
      }],
    };
  },
} satisfies Transformer;
