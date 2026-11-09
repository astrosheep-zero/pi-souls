import assert from "node:assert/strict";
import test from "node:test";
import { wrapReminder } from "../../../src/perception.ts";
import { perceptionTransformer } from "../client/perception-transformer.ts";
import { compactPerceptionLines, PERCEPTION_MESSAGE_TYPE, perceptionSchema } from "../shared/perception.ts";

test("transforms pi-souls perception tool_call into a stripped plugin timeline item", () => {
  const item = {
    type: "tool_call" as const,
    callId: "pi-custom-1",
    name: PERCEPTION_MESSAGE_TYPE,
    status: "completed" as const,
    error: null,
    detail: {
      type: "plain_text" as const,
      text: wrapReminder("⌚ 02:14 · Tue, Oct 27\n(1h since *human* was last present)"),
    },
    metadata: {
      synthetic: true,
      customType: PERCEPTION_MESSAGE_TYPE,
      details: { moment: "human", timestamp: 1761502440000 },
    },
  };
  const result = perceptionTransformer.transform({ item });
  assert.equal(result?.items.length, 1);
  assert.equal(
    perceptionSchema.parse(result!.items[0]!.data).text,
    "⌚ 02:14 · Tue, Oct 27\n(1h since *human* was last present)",
  );
  assert.deepEqual(
    compactPerceptionLines("[some other faye]\n\n*pokes* `` [hi] ``\n\"yo\""),
    ["[some other faye] *pokes* [hi]", "\"yo\""],
  );
  assert.deepEqual(perceptionTransformer.transform({ item }), result);
  assert.equal(
    perceptionTransformer.transform({
      item: { ...item, detail: { type: "plain_text", text: wrapReminder("   ") } },
    }),
    undefined,
  );
  assert.equal(
    perceptionTransformer.transform({
      item: { ...item, metadata: { synthetic: true, customType: "other" } },
    }),
    undefined,
  );
});
