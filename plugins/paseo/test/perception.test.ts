import assert from "node:assert/strict";
import test from "node:test";
import { wrapReminder } from "../../../src/utterance.ts";
import { perceptionTransformer } from "../client/perception-transformer.ts";
import { PERCEPTION_MESSAGE_TYPE, perceptionSchema } from "../shared/perception.ts";

function makeItem(text: string, details?: Record<string, unknown>, customType = PERCEPTION_MESSAGE_TYPE) {
  return {
    type: "tool_call" as const,
    callId: "pi-custom-1",
    name: customType,
    status: "completed" as const,
    error: null,
    detail: { type: "plain_text" as const, text },
    metadata: {
      synthetic: true,
      customType,
      ...(details === undefined ? {} : { details }),
    },
  };
}

test("transforms legacy wrapped pi-souls perception tool_call into a stripped plugin timeline item", () => {
  const item = makeItem(
    wrapReminder("⌚ 02:14 · Tue, Oct 27\n(1h since *human* was last present)"),
    { moment: "human", timestamp: 1761502440000 },
  );
  const result = perceptionTransformer.transform({ item });
  assert.equal(result?.items.length, 1);
  assert.equal(
    perceptionSchema.parse(result!.items[0]!.data).text,
    "⌚ 02:14 · Tue, Oct 27\n(1h since *human* was last present)",
  );
  assert.deepEqual(perceptionTransformer.transform({ item }), result);
  assert.equal(
    perceptionTransformer.transform({ item: makeItem(wrapReminder("   "), { moment: "human" }) }),
    undefined,
  );
  assert.equal(
    perceptionTransformer.transform({ item: makeItem(wrapReminder("hello"), { moment: "human" }, "other") }),
    undefined,
  );
});

test("preserves literal <system-reminder> tags on raw-text utterance carriers", () => {
  const literal = wrapReminder("literal note");
  for (const details of [
    { kind: "reminder", moment: "wake" },
    { kind: "user", moment: "tool" },
    { kind: "assistant", moment: "wake" },
    { moment: "human", kinds: ["reminder"], timestamp: 1761502440000 },
    { moment: "human", kinds: ["reminder", "user"] },
  ]) {
    const result = perceptionTransformer.transform({ item: makeItem(literal, details) });
    assert.equal(result?.items.length, 1);
    assert.equal(perceptionSchema.parse(result!.items[0]!.data).text, literal);
  }

  const batch = `${wrapReminder("first")}\n\n${wrapReminder("second")}`;
  const batchResult = perceptionTransformer.transform({
    item: makeItem(batch, { moment: "human", kinds: ["user", "assistant"] }),
  });
  assert.equal(perceptionSchema.parse(batchResult!.items[0]!.data).text, batch);

  assert.equal(
    perceptionTransformer.transform({ item: makeItem("   ", { kind: "user", moment: "wake" }) }),
    undefined,
  );
});
