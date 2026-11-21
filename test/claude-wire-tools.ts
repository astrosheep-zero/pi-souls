import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { blocks, createWireHost, ownPluginNote, wireNoteLines, type WireMessage } from "./claude-wire-host.ts";
import { unwrapReminder, wrapReminder } from "../src/utterance.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const humanNotes = ["HUMAN_PERCEPTION", "HUMAN_BARE_NOTE"];
const toolNotes = ["PERCEPTION before Read", "PERCEPTION after Read"];
const prohibitedNotes = ["IGNORED_HUMAN_ASSISTANT", "IGNORED_HUMAN_EPHEMERAL", "LATE_HUMAN_PERCEPTION"];
const knownNotes = new Set([...humanNotes, ...toolNotes, ...prohibitedNotes]);
const notesOnWire = (messages: WireMessage[]) => messages.flatMap((message) => wireNoteLines(message)
  .filter((line) => knownNotes.has(line)).map((line) => [message.role, line]));
const userNotes = (lines: string[]) => lines.map((line) => ["user", line]);
const withoutCache = ({ cache_control: _cache, ...block }: ReturnType<typeof blocks>[number]) => block;
const frames = (messages: WireMessage[]) => messages.flatMap((message) =>
  blocks(message).map((block) => ({ role: message.role, block: withoutCache(block) })));

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
    "type Moment = { kind: string; text?: string; phase?: string; toolName?: string };",
    "export default async function perception(moment: Moment) {",
    "  if (moment.kind === 'human' && moment.text === 'read both fixture files') return [",
    "    { kind: 'reminder', text: 'HUMAN_PERCEPTION' },",
    "    { kind: 'assistant', text: 'IGNORED_HUMAN_ASSISTANT' },",
    "    { kind: 'user', text: 'HUMAN_BARE_NOTE' },",
    "    { kind: 'user', text: 'IGNORED_HUMAN_EPHEMERAL', ephemeral: true },",
    "  ];",
    "  if (moment.kind === 'human' && moment.text === 'after the tools') {",
    "    await new Promise((r) => setTimeout(r, 3500));",
    "    return [{ kind: 'reminder', text: 'LATE_HUMAN_PERCEPTION' }];",
    "  }",
    "  if (moment.kind !== \"tool\") return [];",
    "  return [{ kind: 'reminder', text: `PERCEPTION ${moment.phase} ${moment.toolName}` }];",
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
      const seenResult = frames(body.messages).some(({ role, block }) => role === "user" && block.type === "tool_result");
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

    // Human notes are present in order, but tool, skipped and late notes are absent.
    assert.deepEqual(notesOnWire(first.messages), userNotes(humanNotes));
    assert.deepEqual(notesOnWire(second.messages), userNotes(humanNotes));
    const nextTurn = await host.send("after the tools");
    assert.equal(nextTurn.apiBodies.length, 1);
    const third = nextTurn.apiBodies[0]!;

    // Native cache breakpoints may move; keep the message roles and typed blocks intact.
    const traffic = (messages: WireMessage[]) => messages.map((message) => ({ role: message.role,
      blocks: blocks(message).map(withoutCache),
    }));
    assert.deepEqual(traffic(second.messages.slice(0, first.messages.length)), traffic(first.messages));
    assert.deepEqual(traffic(third.messages.slice(0, second.messages.length - 1)), traffic(second.messages.slice(0, -1)));
    const secondFrames = frames(second.messages);
    const ids = ["toolu_one", "toolu_two"];
    assert.deepEqual(secondFrames.filter(({ block }) => block.type === "tool_use").map(({ role, block }) => [role, block.id]),
      ids.map((id) => ["assistant", id]));
    const oldResults = secondFrames.filter(({ block }) => block.type === "tool_result");
    assert.deepEqual(oldResults.map(({ role, block }) => [role, block.tool_use_id]).sort(), ids.map((id) => ["user", id]));
    const flat = frames(third.messages);
    const firstResult = flat.findIndex(({ block }) => block.type === "tool_result");
    const newResults = flat.filter(({ block }) => block.type === "tool_result");
    assert.deepEqual(newResults, oldResults);
    assert.deepEqual(flat.slice(firstResult, firstResult + ids.length), newResults, "tool-result blocks stay adjacent and in order");
    assert.equal(flat.filter(({ role, block }) => role === "user" && block.type === "text" && block.text === "after the tools").length, 1);
    const earlierWire = flat.slice(0, firstResult + ids.length).map(({ role, block }) => ({ role, content: [block] }));
    assert.deepEqual(notesOnWire(earlierWire), userNotes(humanNotes), "tool notes never precede or split results");

    const rows = await host.transcript();
    assert.ok(rows);
    const resultRows = rows.flatMap((row, index) => row.type === "user" && row.message?.role === "user"
      ? blocks(row.message).filter((block) => block.type === "tool_result").map((block) => ({ index, id: block.tool_use_id })) : []);
    assert.deepEqual(resultRows.map(({ id }) => id), newResults.map(({ block }) => block.tool_use_id));
    assert.equal(resultRows[1]!.index - resultRows[0]!.index, 1, "both transcript result rows stay adjacent");
    const delivered = rows.flatMap((row) => ownPluginNote(row)?.delivered ?? []);
    assert.deepEqual(delivered.filter((text) => humanNotes.includes(unwrapReminder(text))), ["<system-reminder>\nHUMAN_PERCEPTION\n</system-reminder>", "HUMAN_BARE_NOTE"]);
    const deliveredTools = delivered.filter((text) => toolNotes.includes(unwrapReminder(text)));
    assert.deepEqual([...deliveredTools].sort(), toolNotes.flatMap((text) => [wrapReminder(text), wrapReminder(text)]).sort());
    assert.deepEqual(notesOnWire(third.messages), userNotes([...humanNotes, ...deliveredTools.map(unwrapReminder)]));
    for (const [index, row] of rows.entries()) {
      const note = ownPluginNote(row);
      const payloads = [...(note?.held ?? []), ...(note?.delivered ?? [])].map(unwrapReminder);
      const uttered = (row.type === "user" || row.type === "assistant") && row.message?.role === row.type ? wireNoteLines(row.message) : [];
      assert.deepEqual([...payloads, ...uttered].filter((text) => prohibitedNotes.includes(text)), []);
      if (payloads.some((text) => toolNotes.includes(text))) assert.ok(index > resultRows[1]!.index, "no tool note precedes or splits kept results");
    }
  } finally {
    await host.stop();
  }
});
