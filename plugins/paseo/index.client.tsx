import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PerceptionRow } from "./client/perception-row.tsx";
import { perceptionTransformer } from "./client/perception-transformer.ts";
import { PERCEPTION_KIND, perceptionSchema } from "./shared/perception.ts";

export default function contribute(client: PluginClientContext) {
  const removals = [
    client.addTimelineRenderer({
      kind: PERCEPTION_KIND,
      version: 1,
      schema: perceptionSchema,
      Component: PerceptionRow,
    }),
    client.addTimelineTransformer(perceptionTransformer),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
