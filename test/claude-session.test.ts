import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeChoice, encodeChoice, readClaudeSession, type SoulChoice } from "../src/claude-session.ts";

type Row = Record<string, unknown>;

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 17, 11, 30 + minute, 0)).toISOString();
const jsonl = (rows: Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function system(uuid: string, parentUuid: string | null, content: string, minute = 0): Row {
  return { uuid, parentUuid, type: "system", subtype: "informational", content, timestamp: at(minute), isSidechain: false };
}

function user(uuid: string, parentUuid: string | null, text: string, minute = 0, extra: Row = {}): Row {
  return {
    uuid, parentUuid, type: "user", timestamp: at(minute), isSidechain: false,
    message: { role: "user", content: [{ type: "text", text }] }, ...extra,
  };
}

function assistant(uuid: string, parentUuid: string | null, model: string, minute = 0): Row {
  return {
    uuid, parentUuid, type: "assistant", timestamp: at(minute), isSidechain: false,
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
  };
}

function attachment(uuid: string, parentUuid: string, systemPrompt: string[], minute = 0): Row {
  return {
    uuid, parentUuid, type: "attachment", timestamp: at(minute), isSidechain: false,
    attachment: { type: "prompt_snapshot", systemPrompt, tools: [] },
  };
}

/** Exactly how Claude stores an own reminder: meta user row, plugin origin, wrapper. */
function pluginReminder(uuid: string, parentUuid: string, text: string, minute = 0): Row {
  return {
    uuid, parentUuid, type: "user", timestamp: at(minute), isSidechain: false, isMeta: true,
    origin: { kind: "plugin", name: "pi-souls" },
    message: { role: "user", content: [{ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }] },
  };
}

test("choice grammar is the exact human notice, with no version or ids", () => {
  const named: SoulChoice = { mode: "named", name: "faye" };
  assert.equal(encodeChoice(named), "Soul choice: @faye");
  assert.equal(encodeChoice({ mode: "disabled" }), "Soul choice: disabled");
  assert.equal(encodeChoice({ mode: "defaults" }), "Soul choice: defaults");
  for (const choice of [named, { mode: "disabled" } as const, { mode: "defaults" } as const]) {
    assert.deepEqual(decodeChoice(encodeChoice(choice)), choice);
    assert.doesNotMatch(encodeChoice(choice), /v1|version|[{}]|uuid/i);
  }
  assert.equal(decodeChoice("ordinary transcript text"), undefined);
  assert.throws(() => decodeChoice("Soul choice: enabled"), /Invalid soul choice/);
  assert.throws(() => decodeChoice("Soul choice: @"), /Invalid soul choice/);
  assert.throws(() => decodeChoice("Soul choice: @bad name"), /Invalid soul choice/);
  assert.throws(() => decodeChoice("Soul choice: @faye\nActive soul: @faye"), /Invalid soul choice/);
  assert.throws(() => encodeChoice({ mode: "named", name: "bad name" }), /Invalid soul name/);
});

test("branch selection follows the head ancestry, not the last line", () => {
  const rows: Row[] = [
    user("u", null, "root", 0),
    assistant("left", "u", "claude-opus-5-5", 1),
    system("left-choice", "left", "Soul choice: @left", 2),
    system("left-divider", "left-choice", "── soul: left ──", 3),
    assistant("right", "u", "claude-sonnet-5-5", 4),
    system("right-choice", "right", "Soul choice: @right", 5),
    system("right-divider", "right-choice", "── soul: right ──", 6),
  ];
  const text = jsonl(rows);
  assert.equal(JSON.parse(text.trim().split("\n").at(-1)!).uuid, "right-divider");

  const left = readClaudeSession(text, "left-divider");
  assert.equal(left.known, true);
  assert.deepEqual(left.choice, { mode: "named", name: "left" });
  assert.equal(left.soul, "left");
  assert.equal(left.model, "claude-opus-5-5");

  const right = readClaudeSession(text, "right-divider");
  assert.equal(right.known, true);
  assert.deepEqual(right.choice, { mode: "named", name: "right" });
  assert.equal(right.soul, "right");
  assert.equal(right.model, "claude-sonnet-5-5");

  const beforeChoice = readClaudeSession(text, "left");
  assert.equal(beforeChoice.known, true);
  assert.equal(beforeChoice.choice, undefined);
});

test("a repeated UUID uses the latest parent rewrite", () => {
  const rows: Row[] = [
    user("root", null, "root", 0),
    system("old-choice", "root", "Soul choice: @old", 1),
    system("new-choice", "root", "Soul choice: @new", 2),
    assistant("dup", "old-choice", "claude-opus-5-5", 3),
    assistant("head", "dup", "claude-opus-5-5", 4),
    assistant("dup", "new-choice", "claude-opus-5-5", 5),
  ];
  const read = readClaudeSession(jsonl(rows), "head");
  assert.equal(read.known, true);
  assert.deepEqual(read.choice, { mode: "named", name: "new" });
});

test("compaction follows logicalParentUuid when the live chain has no older choice", () => {
  const rows: Row[] = [
    user("root", null, "old", 0),
    system("old-choice", "root", "Soul choice: @old", 1),
    system("old-divider", "old-choice", "── soul: old ──", 2),
    assistant("summary", null, "claude-opus-5-5", 3),
    {
      uuid: "boundary", parentUuid: "summary", logicalParentUuid: "old-divider",
      type: "system", subtype: "compact_boundary", timestamp: at(4), isSidechain: false,
    },
    assistant("head", "boundary", "claude-opus-5-5", 5),
    system("new-choice", "boundary", "Soul choice: @new", 6),
    assistant("new-head", "new-choice", "claude-opus-5-5", 7),
  ];
  const text = jsonl(rows);

  const old = readClaudeSession(text, "head");
  assert.equal(old.known, true);
  assert.deepEqual(old.choice, { mode: "named", name: "old" });
  assert.equal(old.soul, "old");

  const newer = readClaudeSession(text, "new-head");
  assert.equal(newer.known, true);
  assert.deepEqual(newer.choice, { mode: "named", name: "new" });
});

test("compact history uses the latest UUID version before the boundary", () => {
  const rows: Row[] = [
    assistant("carrier-old", null, "claude-opus-5-5", 0),
    system("choice-a", "carrier-old", "Soul choice: @a", 1),
    system("choice-b", "choice-a", "Soul choice: @b", 2),
    assistant("dup", "choice-a", "claude-opus-5-5", 3),
    assistant("dup", "choice-b", "claude-opus-5-5", 4),
    assistant("summary", null, "claude-opus-5-5", 5),
    {
      uuid: "boundary", parentUuid: "summary", logicalParentUuid: "dup",
      type: "system", subtype: "compact_boundary", timestamp: at(6), isSidechain: false,
    },
    system("after", "boundary", "unrelated", 7),
    assistant("dup", "summary", "claude-opus-5-5", 8),
  ];
  const read = readClaudeSession(jsonl(rows), "after", ["carrier-old"]);
  assert.equal(read.known, true);
  assert.deepEqual(read.choice, { mode: "named", name: "b" });
  assert.deepEqual(read.retainHandles, []);
});

test("a compact fork without old notices is unknown; a live receipt restores choice", () => {
  const fork: Row[] = [
    {
      uuid: "boundary", parentUuid: null, logicalParentUuid: "dup",
      type: "system", subtype: "compact_boundary", timestamp: at(0), isSidechain: false,
    },
    assistant("summary", "boundary", "claude-opus-5-5", 1),
    assistant("dup", "summary", "claude-opus-5-5", 2),
    system("head", "dup", "unrelated", 3),
  ];
  assert.deepEqual(readClaudeSession(jsonl(fork), "head"), { known: false });

  const receipt: Row[] = [
    ...fork.slice(0, 3),
    assistant("carrier", "dup", "claude-opus-5-5", 3),
    system("receipt", "carrier", "Soul choice: disabled", 4),
    system("receipt-head", "receipt", "unrelated", 5),
  ];
  const read = readClaudeSession(jsonl(receipt), "receipt-head", ["carrier"]);
  assert.equal(read.known, true);
  assert.deepEqual(read.choice, { mode: "disabled" });
  assert.deepEqual(read.retainHandles, ["carrier"]);
});

test("retainHandles choose the nearest supplied live ancestor", () => {
  const rows: Row[] = [
    assistant("carrier-old", null, "claude-opus-5-5", 0),
    system("choice-old", "carrier-old", "Soul choice: @old", 1),
    assistant("carrier-new", "choice-old", "claude-opus-5-5", 2),
    system("choice-new", "carrier-new", "Soul choice: @new", 3),
    system("head", "choice-new", "unrelated", 4),
  ];
  const text = jsonl(rows);
  const read = readClaudeSession(text, "head", ["carrier-old", "carrier-new"]);
  assert.deepEqual(read.choice, { mode: "named", name: "new" });
  assert.deepEqual(read.retainHandles, ["carrier-new"]);

  const noHandles = readClaudeSession(text, "head");
  assert.deepEqual(noHandles.choice, { mode: "named", name: "new" });
  assert.deepEqual(noHandles.retainHandles, []);
});

function rewindRow(leafUuid: string | null, sessionId = "session", extra: Row = {}): Row {
  return { type: "last-prompt", explicit: true, rewound: true, sessionId, leafUuid, cutUuid: "old-head", ...extra };
}

test("explicit native rewind adopts its exact anchor after the tracked head", () => {
  const rows: Row[] = [
    { ...user("root", null, "root", 0), sessionId: "session" },
    { ...system("choice-a", "root", "Soul choice: @a", 1), sessionId: "session" },
    { ...user("anchor", "choice-a", "anchor", 2), sessionId: "session" },
    { ...system("choice-old", "anchor", "Soul choice: @old", 3), sessionId: "session" },
    { ...assistant("old-head", "choice-old", "claude-opus-5-5", 4), sessionId: "session" },
    rewindRow("anchor"),
  ];
  const text = jsonl(rows);
  const before = readClaudeSession(text, "old-head");
  assert.deepEqual(before.choice, { mode: "named", name: "old" });
  assert.equal(before.headUuid, undefined);

  const after = readClaudeSession(text, "old-head", [], "session");
  assert.equal(after.known, true);
  assert.equal(after.headUuid, "anchor");
  assert.deepEqual(after.choice, { mode: "named", name: "a" });

  const wrongSession = readClaudeSession(text, "old-head", [], "other");
  assert.equal(wrongSession.headUuid, undefined);
  assert.deepEqual(wrongSession.choice, { mode: "named", name: "old" });

  const ordinary = readClaudeSession(jsonl([...rows.slice(0, -1), { type: "last-prompt", leafUuid: "anchor", sessionId: "session" }]), "old-head", [], "session");
  assert.equal(ordinary.headUuid, undefined);
  assert.deepEqual(ordinary.choice, { mode: "named", name: "old" });
});

test("rewind marker before a later physical head version is ignored", () => {
  const rows: Row[] = [
    { ...user("root", null, "root", 0), sessionId: "session" },
    { ...user("head", "root", "first", 1), sessionId: "session" },
    rewindRow("root"),
    { ...user("head", "root", "second", 2), sessionId: "session" },
  ];
  const read = readClaudeSession(jsonl(rows), "head", [], "session");
  assert.equal(read.known, true);
  assert.equal(read.headUuid, undefined);
});

test("explicit rewind with null leaf is known empty defaults", () => {
  const rows: Row[] = [
    { ...user("root", null, "root", 0), sessionId: "session" },
    { ...system("choice", "root", "Soul choice: @a", 1), sessionId: "session" },
    { ...assistant("old-head", "choice", "claude-opus-5-5", 2), sessionId: "session" },
    rewindRow(null),
  ];
  assert.deepEqual(readClaudeSession(jsonl(rows), "old-head", [], "session"), {
    known: true,
    headUuid: null,
    retainHandles: [],
  });
});

test("rewind marker must follow the tracked head and have a resolvable anchor", () => {
  const base = [
    { ...user("root", null, "root", 0), sessionId: "session" },
    { ...assistant("old-head", "root", "claude-opus-5-5", 1), sessionId: "session" },
  ];
  const before = readClaudeSession(jsonl([
    rewindRow("root"),
    ...base,
  ]), "old-head", [], "session");
  assert.equal(before.headUuid, undefined);

  assert.deepEqual(readClaudeSession(jsonl([...base, rewindRow("missing")]), "old-head", [], "session"), { known: false });

  const newer = readClaudeSession(jsonl([
    ...base,
    rewindRow("root"),
    { ...system("newer", "old-head", "unrelated", 2), sessionId: "session" },
  ]), "newer", [], "session");
  assert.equal(newer.headUuid, undefined);

  const unrelated = readClaudeSession(jsonl([
    ...base,
    rewindRow("root"),
    {
      uuid: "side", parentUuid: "old-head", type: "user", timestamp: at(2), isSidechain: true,
      sessionId: "session", message: { role: "user", content: [{ type: "text", text: "side" }] },
    },
    {
      uuid: "other", parentUuid: "old-head", type: "user", timestamp: at(3), isSidechain: false,
      sessionId: "other", message: { role: "user", content: [{ type: "text", text: "other" }] },
    },
  ]), "old-head", [], "session");
  assert.equal(unrelated.headUuid, "root");
});

test("missing or unflushed heads are unknown, never defaults", () => {
  const rows = [
    user("root", null, "root"),
    system("choice", "root", "Soul choice: @faye"),
  ];
  const text = jsonl(rows);
  assert.deepEqual(readClaudeSession(text, ""), { known: false });
  assert.deepEqual(readClaudeSession(text, "not-written-yet"), { known: false });
  assert.deepEqual(readClaudeSession(jsonl([user("head", "missing", "hi")]), "head"), { known: false });
  assert.deepEqual(readClaudeSession("", "head"), { known: false });
});

test("continuity comes from delivered rows and the latest prompt snapshot", () => {
  const snapshot = attachment("snapshot", "divider", ["first", "second"], 6);
  const rows: Row[] = [
    user("older", null, "older", 0),
    user("human", "older", "hello", 1),
    assistant("assistant", "human", "claude-backend-alias-5", 2),
    pluginReminder("note", "assistant", "⌚ 11:30 · Mon, Nov 17, 2026", 3),
    pluginReminder("brain", "note", "new brain: claude-sonnet-5-5", 4),
    system("divider", "brain", "── soul: faye ──", 5),
    snapshot,
    system("choice", "snapshot", "Soul choice: @faye", 7),
    assistant("newer-assistant", "choice", "claude-backend-alias-6", 8),
    system("head", "newer-assistant", "unrelated notice", 9),
  ];
  const read = readClaudeSession(jsonl(rows), "head", ["assistant"]);
  assert.equal(read.known, true);
  assert.deepEqual(read.choice, { mode: "named", name: "faye" });
  assert.equal(read.soul, "faye");
  assert.equal(read.model, "claude-sonnet-5-5");
  assert.equal(read.lastHumanAt, Date.parse(at(1)));
  assert.equal(read.previousHumanAt, Date.parse(at(0)));
  assert.equal(read.noteAt, Date.parse(at(3)));
  assert.deepEqual(read.snapshot, { systemPrompt: ["first", "second"] });
  assert.deepEqual(read.retainHandles, ["assistant"]);
});

test("submit attachment clocks retain their human carrier; settings hooks and nonclock text do not count", () => {
  const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`;
  const clock = "⌚ 11:30 · Mon, Nov 17, 2026";
  const attach = (uuid: string, parentUuid: string, hookName: string, time: number, ...parts: string[]) => ({
    uuid, parentUuid, timestamp: at(time), type: "attachment", isSidechain: false,
    attachment: { type: "hook_additional_context", hookName, hookEvent: "UserPromptSubmit", toolUseID: "hook-id", content: parts },
  });
  const rows = [
    user("prompt", null, "human prompt", 0),
    attach("clock", "prompt", "prompt.submit", 1, "unrelated context", reminder(clock + "\n(5h since *human* was last present)")),
    assistant("answer", "clock", "opus", 2),
    user("followup", "answer", "still here", 3),
    attach("settings", "followup", "UserPromptSubmit", 4, reminder(clock)),
    attach("other", "settings", "prompt.submit", 5, reminder(`new soul: fake\nnew brain: fake\n${clock} prose\n⌚ 11:30 · Mon, Nov 17\n⌚ 29:88 · Mon, Nov 17, 2026\n⌚ 11:30 · Mon, Nov 17, 26`)),
  ];
  const read = readClaudeSession(jsonl(rows), "other", ["prompt", "answer", "followup"]);
  assert.equal(read.noteAt, Date.parse(at(1)));
  assert.deepEqual(read.retainHandles, ["prompt"]);
  assert.equal(read.soul, undefined);
  assert.equal(read.model, "opus");

  const yearless = readClaudeSession(jsonl([
    user("prompt", null, "human prompt", 0),
    attach("clock", "prompt", "prompt.submit", 1, reminder("⌚ 11:30 · Mon, Nov 17")),
  ]), "clock", ["prompt"]);
  assert.equal(yearless.noteAt, undefined);
  assert.deepEqual(yearless.retainHandles, []);
});

test("soulless divider and new-soul reminders restore observed identity", () => {
  const none = readClaudeSession(jsonl([
    user("root", null, "root"),
    system("divider", "root", "── soulless ──"),
    system("head", "divider", "unrelated"),
  ]), "head");
  assert.equal(none.soul, null);

  const reminder = readClaudeSession(jsonl([
    user("root", null, "root"),
    pluginReminder("reminder", "root", "new soul: reviewer", 1),
    system("head", "reminder", "unrelated"),
  ]), "head");
  assert.equal(reminder.soul, "reviewer");

  const literalNone = readClaudeSession(jsonl([
    user("root", null, "root"),
    pluginReminder("reminder", "root", "new soul: none", 1),
    system("head", "reminder", "unrelated"),
  ]), "head");
  assert.equal(literalNone.soul, "none");

  const prose = readClaudeSession(jsonl([
    user("root", null, "root"),
    system("prose", "root", "new soul: fake"),
    system("head", "prose", "unrelated"),
  ]), "head");
  assert.equal(prose.soul, undefined);

  const fakeOrigin = readClaudeSession(jsonl([
    user("root", null, "root"),
    {
      uuid: "reminder", parentUuid: "root", type: "user", timestamp: at(1), isSidechain: false, isMeta: true,
      origin: { kind: "plugin", name: "other-plugin" },
      message: { role: "user", content: [{ type: "text", text: "<system-reminder>\nnew soul: fake\n</system-reminder>" }] },
    },
    system("head", "reminder", "unrelated"),
  ]), "head");
  assert.equal(fakeOrigin.soul, undefined);

  const noOrigin = readClaudeSession(jsonl([
    user("root", null, "root"),
    {
      uuid: "reminder", parentUuid: "root", type: "user", timestamp: at(1), isSidechain: false, isMeta: true,
      message: { role: "user", content: [{ type: "text", text: "<system-reminder>\nnew soul: fake\n</system-reminder>" }] },
    },
    system("head", "reminder", "unrelated"),
  ]), "head");
  assert.equal(noOrigin.soul, undefined);

  const systemOrigin = readClaudeSession(jsonl([
    user("root", null, "root"),
    {
      uuid: "reminder", parentUuid: "root", type: "system", subtype: "informational", timestamp: at(1), isSidechain: false,
      origin: { kind: "plugin", name: "pi-souls" },
      content: "<system-reminder>\nnew soul: fake\n</system-reminder>",
    },
    system("head", "reminder", "unrelated"),
  ]), "head");
  assert.equal(systemOrigin.soul, undefined);
});

test("selection is only owned informational system rows", () => {
  const rows = [
    user("root", null, "root"),
    user("meta", "root", "Soul choice: @fake", 1, { isMeta: true }),
    { uuid: "local", parentUuid: "meta", type: "system", subtype: "local_command", content: "Soul choice: @fake", timestamp: at(2) },
    system("head", "local", "unrelated"),
  ];
  const read = readClaudeSession(jsonl(rows), "head");
  assert.equal(read.known, true);
  assert.equal(read.choice, undefined);
});

test("malformed own markers on the active ancestry throw; off-branch ones do not", () => {
  const bad = jsonl([
    user("root", null, "root"),
    system("choice", "root", "Soul choice: @bad name"),
    system("head", "choice", "unrelated"),
  ]);
  assert.throws(() => readClaudeSession(bad, "head"), /Invalid soul choice/);

  const badDivider = jsonl([
    user("root", null, "root"),
    system("divider", "root", "── soul: ──"),
    system("head", "divider", "unrelated"),
  ]);
  assert.throws(() => readClaudeSession(badDivider, "head"), /Invalid soul divider/);

  const rows: Row[] = [
    user("root", null, "root"),
    system("good", "root", "Soul choice: @good"),
    system("head", "good", "unrelated"),
    system("bad", "root", "Soul choice: @bad name"),
  ];
  const offBranch = readClaudeSession(jsonl(rows), "head");
  assert.equal(offBranch.known, true);
  assert.deepEqual(offBranch.choice, { mode: "named", name: "good" });
});

test("actual captured row shape: system choice/divider, plugin wrapper, snapshot", () => {
  const rows: Row[] = [
    {
      uuid: "6abcfcf9-717a-4e48-9c85-7d59c3c6bed8", parentUuid: null, type: "system",
      subtype: "informational", content: "Soul choice: @a", timestamp: "2026-11-17T11:58:00.067Z", isMeta: false,
    },
    {
      uuid: "7b964c3f-82a5-4427-a96c-29b229284eb7", parentUuid: "6abcfcf9-717a-4e48-9c85-7d59c3c6bed8",
      type: "user", timestamp: "2026-11-17T11:58:01.431Z", isSidechain: false, isMeta: true,
      origin: { kind: "plugin", name: "pi-souls" },
      message: { role: "user", content: [{ type: "text", text: "<system-reminder>\nnew soul: a\n</system-reminder>" }] },
    },
    {
      uuid: "8af4db0d-0e1b-418e-993d-3420ca5ed9c1", parentUuid: "7b964c3f-82a5-4427-a96c-29b229284eb7", type: "system",
      subtype: "informational", content: "── soul: a ──", timestamp: "2026-11-17T11:58:01.432Z", isMeta: false,
    },
    {
      uuid: "fa832199-0381-429c-9fac-d77b2c4e1f7a", parentUuid: "8af4db0d-0e1b-418e-993d-3420ca5ed9c1",
      type: "user", timestamp: "2026-11-17T11:58:01.432Z", isSidechain: false, isMeta: true,
      origin: { kind: "plugin", name: "pi-souls" },
      message: { role: "user", content: [{ type: "text", text: "<system-reminder>\n⌚ 19:58 · Tue, Nov 17, 2026\n</system-reminder>" }] },
    },
    {
      uuid: "acada73f-025a-422e-83e9-743ae64eb63d", parentUuid: "fa832199-0381-429c-9fac-d77b2c4e1f7a",
      type: "attachment", timestamp: "2026-11-17T11:58:00.357Z", isSidechain: false,
      attachment: { type: "prompt_snapshot", systemPrompt: ["opening", "SOUL_A_BODY"], tools: [] },
    },
  ];
  const read = readClaudeSession(jsonl(rows), "acada73f-025a-422e-83e9-743ae64eb63d");
  assert.equal(read.known, true);
  assert.deepEqual(read.choice, { mode: "named", name: "a" });
  assert.equal(read.soul, "a");
  assert.equal(read.noteAt, Date.parse("2026-11-17T11:58:01.432Z"));
  assert.deepEqual(read.snapshot, { systemPrompt: ["opening", "SOUL_A_BODY"] });
  assert.deepEqual(read.retainHandles, []);
});
