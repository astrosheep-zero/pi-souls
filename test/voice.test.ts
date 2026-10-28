import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { factsFor, loadVoice, storeDirFor, toolCategory, toolFilePath, toolText, worldFor } from "../src/voice.ts";

const model = { provider: "provider", id: "model" };

/** A souls directory on disk, a Pi stub, and the recorded utterances. */
function setup(files: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "souls-voice-"));
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
  const session = SessionManager.inMemory();
  const sent: { customType: string; content: string; display: boolean; details: unknown }[] = [];
  const notices: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const previous = process.env.SOULLESS;
  let flag = false;
  let now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  const pi = {
    registerFlag: () => {},
    getFlag: () => flag,
    getSettings: () => ({ soulsDir: dir, defaultSoul: "faye", timeaware: false, ...settings }),
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    sendMessage: (message: { customType: string; content: string; display: boolean; details: unknown }) => { sent.push(message); },
    on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
  } as unknown as ExtensionAPI;
  extension(pi);
  const ctx = {
    cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
    getSystemPromptOptions: () => ({ cwd: dir }),
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
  } as unknown as ExtensionContext;
  delete process.env.SOULLESS;
  const fire = async (name: string, event: unknown = {}): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return {
    dir, dirs: dir, session, sent, notices, ctx, fire, settle,
    write: (path: string, text: string) => {
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    },
    soulless: (value: boolean) => { flag = value; },
    at: (value: number) => { now = value; },
    restore: () => {
      if (previous === undefined) delete process.env.SOULLESS; else process.env.SOULLESS = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const realNow = Date.now;

function withTime<T>(now: number, run: (h: ReturnType<typeof setup>) => Promise<T>, files: Record<string, string> = {}, settings: Record<string, unknown> = {}): Promise<T> {
  const h = setup(files, settings);
  Date.now = () => now;
  try {
    return run(h).finally(() => { Date.now = realNow; h.restore(); });
  } catch (error) {
    Date.now = realNow;
    h.restore();
    throw error;
  }
}

test("tool helpers read Pi and Claude shapes the same way", () => {
  assert.equal(toolCategory("read"), "reading");
  assert.equal(toolCategory("Read"), "reading");
  assert.equal(toolCategory("Grep"), "reading");
  assert.equal(toolCategory("bash"), "running");
  assert.equal(toolCategory("Bash"), "running");
  assert.equal(toolCategory("codemode"), "running");
  assert.equal(toolCategory("edit"), "writing");
  assert.equal(toolCategory("MultiEdit"), "writing");
  assert.equal(toolCategory("write"), "writing");
  assert.equal(toolCategory("toString"), "other"); // no prototype leak
  assert.equal(toolCategory("mcp__x__y"), "other");
  assert.equal(toolCategory(""), "other");

  assert.equal(toolFilePath({ path: "/a" }), "/a");
  assert.equal(toolFilePath({ file_path: "/b" }), "/b");
  assert.equal(toolFilePath({ path: "" }), undefined);
  assert.equal(toolFilePath("nope"), undefined);
  assert.equal(toolFilePath(undefined), undefined);

  assert.equal(toolText("plain"), "plain");
  assert.equal(toolText({ a: 1 }), '{"a":1}');
  assert.equal(toolText(undefined), undefined);
  assert.equal(toolText(""), undefined);
  assert.equal(toolText(10), "10");
  const long = toolText("x".repeat(5000))!;
  assert.equal(long.length, 2001);
  assert.ok(long.endsWith("…"));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(toolText(circular), undefined);
});

test("facts describe the local clock and weekend without a timezone guess", () => {
  const night = factsFor(new Date(2026, 9, 27, 2, 14, 0).getTime()); // Tuesday, 02:14 local
  assert.equal(night.hour, 2);
  assert.equal(night.night, true);
  assert.equal(night.morning, false);
  assert.equal(night.weekday, 2);
  assert.equal(night.weekend, false);

  const noon = factsFor(new Date(2026, 9, 24, 12, 0, 0).getTime()); // Saturday, noon
  assert.deepEqual([noon.afternoon, noon.morning, noon.night, noon.weekend], [true, false, false, true]);
  assert.equal(factsFor(new Date(2026, 9, 26, 19, 0, 0).getTime()).evening, true);
  assert.equal(factsFor(new Date(2026, 9, 26, 8, 0, 0).getTime()).morning, true);
  assert.equal(factsFor(Number.NaN).hour, new Date().getHours());
});

test("world carries the soul's own store and omits an unknown absence", () => {
  const world = worldFor({ now: 1_700_000_000_000, sessionId: "s1", cwd: "/work", soul: "faye" });
  assert.equal(world.storeDir, join(homedir(), ".local", "share", "pi-souls", "faye"));
  assert.equal(storeDirFor("reviewer"), join(homedir(), ".local", "share", "pi-souls", "reviewer"));
  assert.equal("absenceMs" in world, false);
  assert.equal(world.sessionId, "s1");
  assert.equal(world.cwd, "/work");
  assert.equal(worldFor({ now: 1, sessionId: "", cwd: "", soul: "x", absenceMs: 5000 }).absenceMs, 5000);
  assert.equal("absenceMs" in worldFor({ now: 1, sessionId: "", cwd: "", soul: "x", absenceMs: -1 }), false);
});

test("a voice module answers, and every failure stays silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-voice-module-"));
  try {
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
    write("speaks.ts", "export function voice(moment, world) { return { text: `${moment.kind}:${world.facts.hour}`, audience: world.facts.night ? 'both' : 'weird' }; }");
    const speaks = loadVoice(join(dir, "speaks.ts"));
    const world = worldFor({ now: new Date(2026, 9, 27, 2, 14, 0).getTime(), sessionId: "s", cwd: "/", soul: "faye" });
    assert.deepEqual(await speaks({ kind: "wake", source: "startup" }, world), { text: "wake:2", audience: "both" });

    write("default.mjs", "export default () => ({ text: 'default export' });");
    assert.deepEqual(await loadVoice(join(dir, "default.mjs"))({ kind: "human", text: "hi" }, world), { text: "default export" });

    write("blank.ts", "export const voice = () => ({ text: '   ' });");
    assert.equal(await loadVoice(join(dir, "blank.ts"))({ kind: "human", text: "hi" }, world), undefined);

    write("nothing.ts", "export const voice = () => undefined;");
    assert.equal(await loadVoice(join(dir, "nothing.ts"))({ kind: "human", text: "hi" }, world), undefined);

    write("throws.ts", "export const voice = () => { throw new Error('boom'); };");
    assert.equal(await loadVoice(join(dir, "throws.ts"))({ kind: "human", text: "hi" }, world), undefined);

    write("not-a-function.ts", "export const voice = 42;");
    assert.equal(await loadVoice(join(dir, "not-a-function.ts"))({ kind: "human", text: "hi" }, world), undefined);

    assert.equal(await loadVoice(join(dir, "missing.ts"))({ kind: "human", text: "hi" }, world), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const wakeVoice = "export function voice(moment, world) {\n"
  + "  const base = { now: world.now, sessionId: world.sessionId, cwd: world.cwd, storeDir: world.storeDir, facts: world.facts, absence: world.absenceMs ?? null };\n"
  + "  return { text: JSON.stringify({ moment, base }), audience: moment.kind === 'human' ? 'human' : undefined };\n"
  + "}\n";

test("Pi wakes the soul through its voice and hands it accurate world facts", async () => {
  const now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  await withTime(now, async (h) => {
    h.session.appendMessage({ role: "user", content: "earlier", timestamp: now - 90_000 });
    await h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.customType, "pi-souls:voice");
    assert.equal(h.sent[0]!.display, false);
    assert.deepEqual(h.sent[0]!.details, { moment: "wake" });
    const said = JSON.parse(h.sent[0]!.content);
    assert.deepEqual(said.moment, { kind: "wake", source: "resume" });
    assert.equal(said.base.sessionId, h.session.getSessionId());
    assert.equal(said.base.cwd, h.dir);
    assert.equal(said.base.now, now);
    assert.equal(said.base.absence, 90_000);
    assert.deepEqual(said.base.storeDir, join(homedir(), ".local", "share", "pi-souls", "faye"));
    assert.equal(said.base.facts.hour, 2);
    assert.equal(said.base.facts.night, true);
  }, { "faye/soul.md": "Directory faye", "faye/voice.ts": wakeVoice });
});

test("Pi maps wake reasons: new is clear, reload is silent, compaction wakes", async () => {
  const files = { "faye/soul.md": "Directory faye", "faye/voice.ts": wakeVoice };
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "reload" });
    assert.equal(h.sent.length, 0);
    for (const [reason, source] of [["startup", "startup"], ["new", "clear"], ["fork", "fork"]] as const) {
      await h.fire("session_start", { type: "session_start", reason });
      assert.deepEqual(JSON.parse(h.sent.at(-1)!.content).moment, { kind: "wake", source });
    }
    await h.fire("session_compact", { type: "session_compact" });
    assert.deepEqual(JSON.parse(h.sent.at(-1)!.content).moment, { kind: "wake", source: "compact" });
  }, files);
});

test("Pi speaks on the human's prompt without blocking the request", async () => {
  await withTime(1_700_000_000_000, async (h) => {
    const options: Record<string, unknown> = { cwd: h.dir };
    const result = await h.fire("before_agent_start", { type: "before_agent_start", prompt: "hello there", systemPromptOptions: options });
    assert.equal(result, undefined); // the handler never waits on a voice module
    await h.settle(() => h.notices.length > 0);
    assert.equal(h.sent.length, 0); // `human` audience is not a transcript message
    assert.equal(h.notices.length, 1);
    const said = JSON.parse(h.notices[0]!);
    assert.deepEqual(said.moment, { kind: "human", text: "hello there" });
  }, { "faye/soul.md": "Directory faye", "faye/voice.ts": wakeVoice });
});

test("Pi answers tool calls before and after, carrying category, path and result", async () => {
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "/work/a.md" } });
    const before = JSON.parse(h.sent.at(-1)!.content).moment;
    assert.deepEqual(before, {
      kind: "tool", phase: "before", category: "reading", toolName: "read",
      filePath: "/work/a.md", input: '{"path":"/work/a.md"}',
    });
    await h.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "contents", isError: false });
    const after = JSON.parse(h.sent.at(-1)!.content).moment;
    assert.deepEqual(after, {
      kind: "tool", phase: "after", category: "reading", toolName: "read",
      filePath: "/work/a.md", input: '{"path":"/work/a.md"}', output: "contents", ok: true,
    });

    await h.fire("tool_call", { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "false" } });
    await h.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: "exit 1", isError: true });
    const failed = JSON.parse(h.sent.at(-1)!.content).moment;
    assert.equal(failed.category, "running");
    assert.equal(failed.ok, false);
    assert.equal(failed.filePath, undefined);
    assert.equal(failed.output, "exit 1");
  }, { "faye/soul.md": "Directory faye", "faye/voice.ts": wakeVoice });
});

test("Pi stays quiet with no voice, soulless, a suppressed soul, or a broken module", async () => {
  const plain = { "faye.md": "File faye" };
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } });
    assert.equal(h.sent.length, 0);
  }, plain);

  const voiced = { "faye/soul.md": "Directory faye", "faye/voice.ts": wakeVoice };
  await withTime(1_700_000_000_000, async (h) => {
    h.soulless(true);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.sent.length, 0);
  }, voiced);

  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPromptOptions: { cwd: h.dir, customPrompt: "My own prompt" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.notices.length, 0);
  }, { "faye/soul.md": "Directory faye", "faye/voice.ts": wakeVoice }, { defaultSoul: "faye" });

  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } });
    assert.equal(h.sent.length, 0);
  }, { "faye/soul.md": "Directory faye", "faye/voice.ts": "export const voice = () => { throw new Error('boom'); };" });
});

test("Pi keeps a human-only utterance out of the model's transcript", async () => {
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c", toolName: "edit", input: { path: "/work/b.md" } });
    assert.equal(h.sent.length, 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0], "tool:before:edit:writing:/work/b.md");
  }, { "faye/soul.md": "Directory faye", "faye/voice.ts": "export const voice = (moment) => ({ text: `${moment.kind}:${moment.phase}:${moment.toolName}:${moment.category}:${moment.filePath}`, audience: 'human' });" });
});
