import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { factsFor, loadPerception, PERCEPTION_MESSAGE_TYPE, storeDirFor, toolCategory, toolFilePath, toolText, unwrapReminder, worldFor, wrapReminder } from "../src/perception.ts";

function perceptionText(content: string): string {
  assert.match(content, /^<system-reminder>\n[\s\S]*\n<\/system-reminder>$/);
  return content.slice("<system-reminder>\n".length, -"\n</system-reminder>".length);
}

test("Pi SDK persists wrapped builtin and directory utterances and sends them as model context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-perception-context-"));
  let dispose: (() => void) | undefined;
  try {
    mkdirSync(join(dir, "faye"));
    writeFileSync(join(dir, "faye/SOUL.md"), "Faye");
    writeFileSync(join(dir, "faye/perception.ts"), "export const perception = (moment) => moment.kind === 'human' ? { text: 'directory note' } : undefined;");
    const settings = SettingsManager.inMemory({ soulsDir: dir, defaultSoul: "faye" } as any);
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [extension],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = modelRuntime.getModels("openai")[0]!;
    await modelRuntime.setRuntimeApiKey(model.provider, "test-key-never-sent");
    const sessionManager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings, sessionManager, modelRuntime, model, resourceLoader: loader, noTools: "all" });
    dispose = () => session.dispose();
    const requests: TranscriptContext["messages"][] = [];
    session.agent.streamFunction = (requestModel, context) => {
      requests.push(structuredClone(context.messages));
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Done" }],
        api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    const errors: string[] = [];
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    await session.prompt("hello");
    const notes = sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === PERCEPTION_MESSAGE_TYPE);
    assert.equal(notes.length, 2);
    assert.ok(notes.every((entry) => entry.type === "custom_message" && entry.display === true));
    const contents = notes.map((entry) => {
      assert.equal(entry.type, "custom_message");
      assert.equal(typeof entry.content, "string");
      return entry.content as string;
    });
    assert.match(perceptionText(contents[0]!), /^⌚ /);
    assert.equal(contents[1], wrapReminder("directory note"));
    const sent = requests[0]!.map((message) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
    for (const content of contents) assert.ok(sent.includes(content));
    assert.deepEqual(errors, []);
  } finally {
    dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

const model = { provider: "provider", id: "model" };

/** A souls directory on disk, a Pi stub, and the recorded utterances. */
function setup(files: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "souls-perception-"));
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
  const session = SessionManager.inMemory();
  const sent: { customType: string; content: string; display: boolean; details: unknown }[] = [];
  const messageRenderers = new Map<string, any>();
  const notices: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const previous = process.env.SOULLESS;
  let flag = false;
  let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
  let footer: string | undefined;
  let now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  const pi = {
    registerFlag: () => {},
    getFlag: () => flag,
    getSettings: () => ({ soulsDir: dir, defaultSoul: "faye", timeaware: false, ...settings }),
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    registerCommand: (_name: string, registered: typeof command) => { command = registered; },
    registerEntryRenderer: () => {},
    registerMessageRenderer: (type: string, renderer: unknown) => { messageRenderers.set(type, renderer); },
    sendMessage: (message: { customType: string; content: string; display: boolean; details: unknown }) => { sent.push(message); },
    on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
  } as unknown as ExtensionAPI;
  extension(pi);
  const ctx = {
    cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
    getSystemPromptOptions: () => ({ cwd: dir }),
    ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, text: string | undefined) => { footer = text; } },
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
    dir, dirs: dir, session, sent, messageRenderers, notices, ctx, fire, settle, command,
    footer: () => footer,
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

test("a perception module answers, and every failure stays silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-perception-module-"));
  try {
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
    write("speaks.ts", "export function perception(moment, world) { return { text: `${moment.kind}:${world.facts.hour}`, extra: 1 }; }");
    const speaks = loadPerception(join(dir, "speaks.ts"));
    const world = worldFor({ now: new Date(2026, 9, 27, 2, 14, 0).getTime(), sessionId: "s", cwd: "/", soul: "faye" });
    assert.deepEqual(await speaks({ kind: "wake", source: "startup" }, world), { text: "wake:2" });
    write("speaks.ts", "export function perception() { return { text: 'fresh instance' }; }");
    assert.deepEqual(await loadPerception(join(dir, "speaks.ts"))({ kind: "human", text: "hi" }, world), { text: "fresh instance" });
    assert.deepEqual(await speaks({ kind: "wake", source: "startup" }, world), { text: "wake:2" });

    write("default.mjs", "export default () => ({ text: 'default export' });");
    assert.deepEqual(await loadPerception(join(dir, "default.mjs"))({ kind: "human", text: "hi" }, world), { text: "default export" });

    write("callable.ts", "module.exports = function perception() { return { text: 'callable' }; };");
    assert.deepEqual(await loadPerception(join(dir, "callable.ts"))({ kind: "human", text: "hi" }, world), { text: "callable" });

    write("blank.ts", "export const perception = () => ({ text: '   ' });");
    assert.equal(await loadPerception(join(dir, "blank.ts"))({ kind: "human", text: "hi" }, world), undefined);

    write("nothing.ts", "export const perception = () => undefined;");
    assert.equal(await loadPerception(join(dir, "nothing.ts"))({ kind: "human", text: "hi" }, world), undefined);

    write("throws.ts", "export const perception = () => { throw new Error('boom'); };");
    assert.equal(await loadPerception(join(dir, "throws.ts"))({ kind: "human", text: "hi" }, world), undefined);

    write("not-a-function.ts", "export const perception = 42;");
    assert.equal(await loadPerception(join(dir, "not-a-function.ts"))({ kind: "human", text: "hi" }, world), undefined);

    assert.equal(await loadPerception(join(dir, "missing.ts"))({ kind: "human", text: "hi" }, world), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const wakePerception = "export function perception(moment, world) {\n"
  + "  const base = { now: world.now, sessionId: world.sessionId, cwd: world.cwd, storeDir: world.storeDir, facts: world.facts, absence: world.absenceMs ?? null };\n"
  + "  return { text: JSON.stringify({ moment, base }) };\n"
  + "}\n";

test("Pi wakes the soul through its perception and hands it accurate world facts", async () => {
  const now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  await withTime(now, async (h) => {
    h.session.appendMessage({ role: "user", content: "earlier", timestamp: now - 90_000 });
    await h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.customType, "pi-souls:perception");
    assert.equal(h.sent[0]!.display, true);
    assert.deepEqual(h.sent[0]!.details, { moment: "wake" });
    const said = JSON.parse(perceptionText(h.sent[0]!.content));
    assert.deepEqual(said.moment, { kind: "wake", source: "resume" });
    assert.equal(said.base.sessionId, h.session.getSessionId());
    assert.equal(said.base.cwd, h.dir);
    assert.equal(said.base.now, now);
    assert.equal(said.base.absence, 90_000);
    assert.deepEqual(said.base.storeDir, join(homedir(), ".local", "share", "pi-souls", "faye"));
    assert.equal(said.base.facts.hour, 2);
    assert.equal(said.base.facts.night, true);
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception });
});

test("Pi maps wake reasons: new is clear, reload is silent, compaction wakes", async () => {
  const files = { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception };
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "reload" });
    assert.equal(h.sent.length, 0);
    for (const [reason, source] of [["startup", "startup"], ["new", "clear"], ["fork", "fork"]] as const) {
      await h.fire("session_start", { type: "session_start", reason });
      assert.deepEqual(JSON.parse(perceptionText(h.sent.at(-1)!.content)).moment, { kind: "wake", source });
    }
    await h.fire("session_compact", { type: "session_compact" });
    assert.deepEqual(JSON.parse(perceptionText(h.sent.at(-1)!.content)).moment, { kind: "wake", source: "compact" });
  }, files);
});

test("/soul reload revalidates the SOUL and its fragments, then reimports the perception", async () => {
  const files = {
    "faye/SOUL.md": "---\nicon: 🦈\n---\nSoul v1 {% render 'parts/shared' %}",
    "parts/shared.md": "original",
    "faye/perception.ts": `export function perception(moment) { return { text: "r1:" + moment.source }; }`,
  };
  await withTime(1_700_000_000_000, async (h) => {
    const before = h.session.getBranch().length;
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /No soul to reload/);
    assert.equal(h.session.getBranch().length, before);

    await h.command.handler("@faye", h.ctx);
    const selected = h.session.getBranch().length;
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("r1:startup"));
    assert.equal(h.footer(), "🦈");

    // Neither a broken SOUL nor a broken fragment may evict the working module.
    h.write("faye/SOUL.md", " ");
    h.write("faye/perception.ts", `export function perception(moment) { return { text: "r2:" + moment.source }; }`);
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /Soul "faye" is empty/);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("r1:compact"));
    h.write("faye/SOUL.md", "Soul {% render 'parts/shared' %}");
    h.write("parts/shared.md", "{{ missing }}");
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /Soul "faye" template/);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("r1:compact"));

    h.write("parts/shared.md", "SHARED {{ model.id }}");
    h.write("faye/SOUL.md", "---\nicon: 🦊\n---\nSoul v2 {% render 'parts/shared' %}");
    const sentBeforeReload = h.sent.length;
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /Reloaded faye/);
    assert.equal(h.footer(), "🦊");
    assert.equal(h.sent.length, sentBeforeReload); // No perception or model turn from the command.
    assert.equal(h.session.getBranch().length, selected); // No divider or new selection.
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("r2:compact"));
  }, files, { defaultSoul: undefined });
});

test("/soul reload refreshes CommonJS perceptions without evicting other souls", async () => {
  const code = (text: string) => `exports.perception = () => ({ text: '${text}' });`;
  const files = {
    "package.json": '{"type":"commonjs"}',
    "faye/SOUL.md": "Faye", "faye/perception.js": code("f1"),
    "other/SOUL.md": "Other", "other/perception.js": code("o1"),
  };
  await withTime(1_700_000_000_000, async (h) => {
    await h.command.handler("@other", h.ctx);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("o1"));
    await h.command.handler("@faye", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("f1"));

    h.write("faye/perception.js", code("f2"));
    h.write("other/perception.js", code("o2"));
    await h.command.handler("reload", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("f2"));

    // A missing entry still invalidates the soul's old cached perception.
    rmSync(join(h.dir, "faye/perception.js"));
    await h.command.handler("reload", h.ctx);
    h.write("faye/perception.js", code("f3"));
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("f3"));

    await h.command.handler("@other", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("o1"));
    await h.command.handler("reload", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, wrapReminder("o2"));
  }, files);
});

test("Pi speaks on the human's prompt without blocking the request", async () => {
  await withTime(1_700_000_000_000, async (h) => {
    const options: Record<string, unknown> = { cwd: h.dir };
    const result = await h.fire("before_agent_start", { type: "before_agent_start", prompt: "hello there", systemPromptOptions: options });
    assert.equal(result, undefined); // the handler never waits on a perception module
    await h.settle(() => h.sent.length > 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.sent[0]!.display, true);
    const said = JSON.parse(perceptionText(h.sent[0]!.content));
    assert.deepEqual(said.moment, { kind: "human", text: "hello there" });
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception });
});

test("Pi answers tool calls before and after, carrying category, path and result", async () => {
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "/work/a.md" } });
    assert.equal(h.sent.at(-1)!.display, true);
    assert.equal(h.notices.length, 0);
    const before = JSON.parse(perceptionText(h.sent.at(-1)!.content)).moment;
    assert.deepEqual(before, {
      kind: "tool", phase: "before", category: "reading", toolName: "read",
      filePath: "/work/a.md", input: '{"path":"/work/a.md"}',
    });
    await h.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "contents", isError: false });
    const after = JSON.parse(perceptionText(h.sent.at(-1)!.content)).moment;
    assert.deepEqual(after, {
      kind: "tool", phase: "after", category: "reading", toolName: "read",
      filePath: "/work/a.md", input: '{"path":"/work/a.md"}', output: "contents", ok: true,
    });

    await h.fire("tool_call", { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "false" } });
    await h.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: "exit 1", isError: true });
    const failed = JSON.parse(perceptionText(h.sent.at(-1)!.content)).moment;
    assert.equal(failed.category, "running");
    assert.equal(failed.ok, false);
    assert.equal(failed.filePath, undefined);
    assert.equal(failed.output, "exit 1");
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception });
});

test("Pi builtin and directory perceptions share a human moment and fail independently", async () => {
  const now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  await withTime(now, async (h) => {
    await h.fire("before_agent_start", { prompt: "hi", systemPromptOptions: { cwd: h.dir } });
    await h.settle(() => h.sent.length === 2);
    assert.equal(h.sent[0]!.content, wrapReminder("⌚ 02:14 · Tue, Oct 27"));
    assert.deepEqual(h.sent[0]!.details, { moment: "human", timestamp: now });
    assert.deepEqual(h.sent[1]!.details, { moment: "human" });
    const said = JSON.parse(perceptionText(h.sent[1]!.content));
    assert.deepEqual(said.moment, { kind: "human", text: "hi" });
    assert.equal(said.base.now, now);
    assert.ok(h.sent.every((message) => message.display === true));
    const renderer = h.messageRenderers.get(PERCEPTION_MESSAGE_TYPE)!;
    const rendered = renderer(
      { customType: PERCEPTION_MESSAGE_TYPE, content: wrapReminder("⌚ 02:14 · Tue, Oct 27\n(1h since *human* was last present)") },
      { expanded: false, outputPad: 1 },
      { fg: (tone: string, text: string) => `[${tone}:${text}]` },
    );
    assert.deepEqual(rendered.render(80).map((line: string) => line.trimEnd()), [
      " [borderMuted:│ ][dim:⌚ 02:14 · Tue, Oct 27]",
      " [borderMuted:│ ][dim:(1h since ][dim:human][dim: was last present)]",
    ]);
    const multiLine = wrapReminder("[some other faye]\n\n*pokes screen* `` [too slow] ``\n\"hey copy\"\nline 4");
    const folded = renderer(
      { customType: PERCEPTION_MESSAGE_TYPE, content: multiLine },
      { expanded: false, outputPad: 1 },
      { fg: (tone: string, text: string) => `[${tone}:${text}]` },
    );
    assert.deepEqual(folded.render(120).map((line: string) => line.trimEnd()), [
      " [borderMuted:│ ][muted:[some other faye]][dim: ][dim:pokes screen][dim: ][muted:[too slow]]",
      " [borderMuted:│ ][dim:\"hey copy\"][muted:…]",
    ]);
    const unfolded = renderer(
      { customType: PERCEPTION_MESSAGE_TYPE, content: multiLine },
      { expanded: true, outputPad: 1 },
      { fg: (tone: string, text: string) => `[${tone}:${text}]` },
    );
    assert.deepEqual(unfolded.render(120).map((line: string) => line.trimEnd()), [
      " [borderMuted:│ ][muted:[some other faye]][dim: ][dim:pokes screen][dim: ][muted:[too slow]]",
      " [borderMuted:│ ][dim:\"hey copy\"]",
      " [borderMuted:│ ][dim:line 4]",
    ]);
    assert.equal(unwrapReminder(wrapReminder("hello")), "hello");

    // A failed soul render suppresses the clock, while its independent module can still answer.
    h.write("faye/SOUL.md", "{{ missing }}");
    h.sent.length = 0;
    await h.fire("before_agent_start", { prompt: "again", systemPromptOptions: { cwd: h.dir } });
    await h.settle(() => h.sent.length === 1);
    assert.deepEqual(h.sent[0]!.details, { moment: "human" });
  }, { "faye/SOUL.md": "Faye", "faye/perception.ts": wakePerception }, { timeaware: true });

  await withTime(now, async (h) => {
    await h.fire("before_agent_start", { prompt: "hi", systemPromptOptions: { cwd: h.dir } });
    await h.settle(() => h.sent.length > 0);
    assert.equal(h.sent[0]!.content, wrapReminder("⌚ 02:14 · Tue, Oct 27"));
    // Await the same broken module through an event handler to finish the pending human perception.
    await h.fire("session_compact");
    assert.equal(h.sent.length, 1);
  }, { "faye/SOUL.md": "Faye", "faye/perception.ts": "export const perception = () => { throw new Error('boom'); };" }, { timeaware: true });
});

test("Pi stays quiet with no perception, soulless, a suppressed soul, or a broken module", async () => {
  const plain = { "faye.md": "File faye" };
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } });
    assert.equal(h.sent.length, 0);
  }, plain);

  const withPerception = { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception };
  await withTime(1_700_000_000_000, async (h) => {
    h.soulless(true);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.sent.length, 0);
  }, withPerception);

  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPromptOptions: { cwd: h.dir, customPrompt: "My own prompt" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.notices.length, 0);
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception }, { defaultSoul: "faye" });

  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } });
    assert.equal(h.sent.length, 0);
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": "export const perception = () => { throw new Error('boom'); };" });
});
