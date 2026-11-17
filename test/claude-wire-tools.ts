import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createWireHost } from "./claude-wire-host.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

type Block = { type?: string; tool_use_id?: string; text?: string; [key: string]: unknown };
type ToolResultPosition = { index: number; id: string };

function blocks(message: any): Block[] {
  return Array.isArray(message?.content) ? message.content : [];
}

function soulsDirFor(dir: string): string {
  return join(dir, "home", ".agents", "souls");
}

/** A directory soul whose perception marks both sides of every tool call. */
function soul(soulsDir: string): void {
  mkdirSync(join(soulsDir, "a"), { recursive: true });
  writeFileSync(join(soulsDir, "a", "SOUL.md"), [
    "---",
    "name: A",
    "icon: a",
    "---",
    "You are soul A. Read only the fixture files.",
  ].join("\n"));
  writeFileSync(join(soulsDir, "a", "perception.ts"), [
    "type Moment = { kind: string; phase?: string; toolName?: string };",
    "export default function perception(moment: Moment) {",
    "  if (moment.kind !== \"tool\") return undefined;",
    "  return { text: `PERCEPTION ${moment.phase} ${moment.toolName}` };",
    "}",
  ].join("\n"));
}

test("parallel Read results stay contiguous before future-only soul reminders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-souls-wire-tools-"));
  roots.push(dir);
  const soulsDir = soulsDirFor(dir);
  soul(soulsDir);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const one = join(work, "one.txt");
  const two = join(work, "two.txt");
  writeFileSync(one, "ONE\n");
  writeFileSync(two, "TWO\n");

  const settings = JSON.stringify({
    pluginConfigs: {
      "pi-souls@inline": { options: { soulsDir, defaultSoul: "a", timeaware: false } },
    },
  });
  const host = await createWireHost({
    dir,
    soulsDir,
    tools: ["Read"],
    args: ["--settings", settings],
    response: (body) => {
      const seenResult = body.messages.some((message: any) => blocks(message).some((block) => block.type === "tool_result"));
      if (seenResult) return { content: [{ type: "text", text: "both files read" }], stop_reason: "end_turn" };
      return {
        content: [
          { type: "tool_use", id: "toolu_one", name: "Read", input: { file_path: one } },
          { type: "tool_use", id: "toolu_two", name: "Read", input: { file_path: two } },
        ],
        stop_reason: "tool_use",
      };
    },
  });

  try {
    const toolTurn = await host.send("read both fixture files");
    assert.equal(toolTurn.result.result, "both files read");
    assert.equal(toolTurn.apiBodies.length, 2);
    const [first, second] = toolTurn.apiBodies;
    assert.ok(first && second);

    // The first request cannot know what the tools will say; the tool continuation is
    // already shaped without the reminders too.
    assert.doesNotMatch(JSON.stringify(first.messages), /PERCEPTION /);
    assert.doesNotMatch(JSON.stringify(second.messages), /PERCEPTION /);

    // A later prompt is the first request that may carry them, with every prior
    // message still byte-for-byte in place.
    const nextTurn = await host.send("after the tools");
    assert.equal(nextTurn.apiBodies.length, 1);
    const third = nextTurn.apiBodies[0]!;
    assert.match(JSON.stringify(third.messages), /PERCEPTION before Read/);
    assert.match(JSON.stringify(third.messages), /PERCEPTION after Read/);
    const semantic = (messages: any[]) => messages.map((message: any) => ({
      role: message.role,
      text: typeof message.content === "string"
        ? message.content
        : blocks(message).map((block) => typeof block.text === "string" ? block.text : JSON.stringify(block)).join("\n"),
    }));
    assert.deepEqual(semantic(second.messages).slice(0, first.messages.length), semantic(first.messages));
    // The last second-request message is the tool-result carrier: it may grow
    // reminders after its kept blocks, but everything before it is unchanged.
    assert.deepEqual(semantic(third.messages).slice(0, second.messages.length - 1), semantic(second.messages.slice(0, -1)));
    const oldCarrier = blocks(second.messages.at(-1));
    const newCarrier = blocks(third.messages[second.messages.length - 1]);
    const oldResults = oldCarrier.filter((block) => block.type === "tool_result");
    const newResults = newCarrier.filter((block) => block.type === "tool_result");
    assert.deepEqual(newResults.map((block) => [block.tool_use_id, block.content]), oldResults.map((block) => [block.tool_use_id, block.content]));

    const results: ToolResultPosition[] = third.messages.flatMap((message: any, index: number) =>
      blocks(message).flatMap((block): ToolResultPosition[] => block.type === "tool_result"
        ? [{ index, id: typeof block.tool_use_id === "string" ? block.tool_use_id : "" }]
        : []));
    assert.deepEqual(results.map((item) => item.id).sort(), ["toolu_one", "toolu_two"]);
    const resultIndexes: number[] = [...new Set(results.map((item) => item.index))];
    assert.equal(resultIndexes.at(-1)! - resultIndexes[0]!, resultIndexes.length - 1, "results form one contiguous message block");

    const flat: Block[] = third.messages.flatMap((message: any): Block[] => blocks(message));
    const resultPositions: number[] = flat.flatMap((block, index): number[] => block.type === "tool_result" ? [index] : []);
    const reminderPositions: number[] = flat.flatMap((block, index): number[] => block.type === "text" && String(block.text).includes("PERCEPTION ") ? [index] : []);
    assert.equal(resultPositions.length, 2);
    assert.equal(resultPositions[1]! - resultPositions[0]!, 1, "both tool_result blocks stay adjacent");
    assert.ok(reminderPositions[0]! > resultPositions[1]!, "reminders follow the kept result pair");
    const newPrompt = third.messages.at(-1);
    assert.equal(typeof newPrompt?.content === "string" ? newPrompt.content : blocks(newPrompt)[0]?.text, "after the tools");

    const rows = await host.transcript();
    assert.ok(rows);
    const resultRows = rows.flatMap((row, index) => row.type === "user" && blocks(row.message).some((block) => block.type === "tool_result") ? [index] : []);
    assert.equal(resultRows.length, 2);
    assert.equal(resultRows[1]! - resultRows[0]!, 1, "both kept tool-result rows are adjacent");
    const firstReminder = rows.findIndex((row) => JSON.stringify(row).includes("PERCEPTION "));
    assert.ok(firstReminder > resultRows[1]!, "no reminder splits or precedes the tool-result pair");
  } finally {
    await host.stop();
  }
});
