import assert from "node:assert/strict";
import test from "node:test";
import { wrapReminder } from "../../../src/utterance.ts";
import { perceptionTransformer } from "../client/perception-transformer.ts";
import { PERCEPTION_MESSAGE_TYPE, perceptionSchema } from "../shared/perception.ts";
import { timeHue } from "../shared/tint.ts";

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
    wrapReminder("⌚ 02:14 · Tue, Oct 27, 2026\n(1h since *human* was last present)"),
    { moment: "human", timestamp: 1761502440000 },
  );
  const result = perceptionTransformer.transform({ item });
  assert.equal(result?.items.length, 1);
  assert.equal(
    perceptionSchema.parse(result!.items[0]!.data).text,
    "⌚ 02:14 · Tue, Oct 27, 2026\n(1h since *human* was last present)",
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

test("forwards finite details.timestamp as data.at and omits it when absent", () => {
  const withTs = perceptionTransformer.transform({
    item: makeItem("⌚ 07:47", { kind: "reminder", timestamp: 1761502440000 }),
  });
  assert.deepEqual(perceptionSchema.parse(withTs!.items[0]!.data), {
    text: "⌚ 07:47",
    at: 1761502440000,
  });

  const withoutTs = perceptionTransformer.transform({
    item: makeItem("⌚ 07:47", { kind: "reminder" }),
  });
  assert.deepEqual(perceptionSchema.parse(withoutTs!.items[0]!.data), { text: "⌚ 07:47" });
});

test("timeHue drifts continuously across 24h while avoiding muddy yellow-green angles", () => {
  for (let m = 0; m < 24 * 60; m += 15) {
    const hue = timeHue(new Date(2026, 10, 23, Math.floor(m / 60), m % 60));
    assert.ok(hue >= 0 && hue < 360, `out of range: ${hue}`);
    assert.ok(hue < 62 || hue >= 162, `landed in muddy zone at ${m}m: ${hue}`);
  }
  const justBeforeMidnight = timeHue(new Date(2026, 10, 23, 23, 59, 59));
  const midnight = timeHue(new Date(2026, 10, 24, 0, 0, 0));
  assert.ok(Math.abs(justBeforeMidnight - midnight) < 1, "midnight wrap must be continuous");

  const samples = [2, 6, 12, 18, 22].map((h) => Math.round(timeHue(new Date(2026, 10, 23, h, 30))));
  assert.equal(new Set(samples).size, samples.length, "key phases of day must be distinct");
});
