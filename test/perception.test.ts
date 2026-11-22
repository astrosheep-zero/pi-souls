import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type BeforeAgentStartEventResult, type CustomMessageEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { factsFor, loadPerception, PERCEPTION_MESSAGE_TYPE, storeDirFor, toolCategory, toolFilePath, toolText, worldFor } from "../src/perception.ts";
import { utterances, wrapReminder } from "../src/utterance.ts";
import { formatClock } from "../src/time.ts";

function textBlocks(content: string | readonly { type: string; text?: string }[]): string[] {
  return typeof content === "string" ? [content] : content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []);
}
const requestText = (messages: TranscriptContext["messages"]) => messages.map(({ content }) => textBlocks(content).join(""));
const spoken = (messages: readonly AgentMessage[]) => messages.flatMap((message) =>
  message.role === "user" || message.role === "assistant" || message.role === "custom" && message.customType === PERCEPTION_MESSAGE_TYPE
    ? textBlocks(message.content) : []);
const notesFor = (session: SessionManager) => session.getBranch().filter((entry): entry is CustomMessageEntry =>
  entry.type === "custom_message" && entry.customType === PERCEPTION_MESSAGE_TYPE);
const clockAt = (at: number) => `⌚ ${formatClock(new Date(at))}`;

async function setupSdk(t: TestContext, perception: string) {
  const dir = mkdtempSync(join(tmpdir(), "souls-perception-context-"));
  let dispose: (() => void) | undefined;
  t.after(() => {
    dispose?.();
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, "faye"));
  writeFileSync(join(dir, "faye/SOUL.md"), "Faye");
  writeFileSync(join(dir, "input.txt"), "fixture");
  writeFileSync(join(dir, "faye/perception.ts"), perception);
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
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings, sessionManager, modelRuntime, model, resourceLoader: loader, tools: ["read"], thinkingLevel: "off" });
  dispose = () => session.dispose();
  const requests: TranscriptContext["messages"][] = [];
  let reads: string[] = [];
  session.agent.streamFunction = (requestModel, context) => {
    requests.push(structuredClone(context.messages));
    const read = reads.length > 0;
    const message: AssistantMessage = {
      role: "assistant", content: read
        // Distinct outputs prevent two results with the same timestamp from being indistinguishable anchors.
        ? reads.map((id, index) => ({ type: "toolCall", id, name: "read", arguments: { path: join(dir, index === 0 ? "input.txt" : "faye/SOUL.md") } }))
        : [{ type: "text", text: "Done" }],
      api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: read ? "toolUse" : "stop", timestamp: Date.now(),
    };
    reads = [];
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: read ? "toolUse" : "stop", message });
    stream.end();
    return stream;
  };
  const errors: string[] = [];
  await session.bindExtensions({ onError: (event) => errors.push(event.error) });
  return { session, sessionManager, requests, errors, readNext: (...ids: string[]) => { reads = ids; } };
}

test("Pi SDK persists reminders but anchors ephemeral only in requests of its human run", async (t) => {
  const { session, sessionManager, requests, errors, readNext } = await setupSdk(t, `
    let ephemeralCalls = 0;
    export function perception(moment) {
      if (moment.kind !== 'human') return [];
      if (moment.text.startsWith('ephemeral ')) return [{ kind: 'reminder', ephemeral: true, text: 'ephemeral #' + ++ephemeralCalls }];
      return [{ kind: 'reminder', text: '  directory: ' + moment.text + '  ' }];
    }
  `);
  await session.prompt("hello");
  const notes = () => notesFor(sessionManager);
  assert.equal(notes().length, 1);
  const first = notes()[0]!;
  const { timestamp } = first.details as { timestamp: number };
  assert.equal(first.display, true);
  assert.deepEqual(first.details, { kinds: ["reminder", "reminder"], moment: "human", timestamp });
  assert.deepEqual(first.content, [{ type: "text", text: clockAt(timestamp) }, { type: "text", text: "  directory: hello  " }]);
  const sent = (i: number) => requestText(requests[i]!);
  assert.deepEqual(sent(0).slice(-3), ["hello", wrapReminder(clockAt(timestamp)), wrapReminder("  directory: hello  ")]);
  await session.prompt("again");
  assert.equal(notes().length, 2);
  assert.deepEqual(notes()[1]!.content, [{ type: "text", text: "  directory: again  " }]);
  assert.deepEqual(notes()[1]!.details, { kinds: ["reminder"], moment: "human" });
  assert.ok(sent(1).includes(wrapReminder("  directory: again  ")));

  readNext("read-1");
  await session.steer("queued steering user"); // Already queued by the first request.
  await session.prompt("ephemeral one");
  assert.equal(requests.length, 4);
  assert.ok(requests[3]!.some((message) => message.role === "toolResult"));
  const firstEphemeral = wrapReminder("ephemeral #1");
  for (const index of [2, 3]) {
    const text = sent(index);
    assert.ok(text.includes("queued steering user"));
    assert.equal(text[text.indexOf("ephemeral one") + 1], firstEphemeral);
    assert.equal(text.filter((value) => value === firstEphemeral).length, 1);
    assert.equal(requests[index]![text.indexOf(firstEphemeral)]!.role, "user");
  }
  await session.sendCustomMessage({ customType: "test", content: "custom turn", display: false }, { triggerTurn: true });
  assert.ok(sent(4).includes("custom turn"));
  assert.ok(!sent(4).includes(firstEphemeral));

  await session.prompt("ephemeral two");
  assert.equal(sent(5)[sent(5).indexOf("ephemeral two") + 1], wrapReminder("ephemeral #2"));
  assert.ok(!sent(5).includes(firstEphemeral));
  await session.prompt("/soul clear");
  await session.prompt("ephemeral without a soul");
  const ephemeralText = [firstEphemeral, wrapReminder("ephemeral #2")];
  assert.deepEqual(spoken(requests[6]!).filter((text) => ephemeralText.includes(text)), []);
  assert.equal(notes().length, 2);
  assert.deepEqual(spoken(sessionManager.buildSessionContext().messages).filter((text) => ephemeralText.includes(text)), []);
  assert.deepEqual(errors, []);
});

test("Pi discards a failed human preparation instead of carrying its speech or clock to the next prompt", async (t) => {
  const { session, sessionManager, requests, errors } = await setupSdk(t, `
    let prepares = 0;
    export function perception(moment) {
      if (moment.kind !== 'human') return [];
      const batch = [{ kind: 'user', text: moment.text + ' #' + ++prepares }];
      if (prepares === 1) batch.push({ kind: 'user', text: 'failed ephemeral', ephemeral: true });
      return batch;
    }
  `);
  // Buffer.from rejects null during normalization, after Pi has run before_agent_start.
  await assert.rejects(session.prompt("failed", { images: [{ type: "image", mimeType: "image/png", data: null as unknown as string }] }),
    { code: "ERR_INVALID_ARG_TYPE" });
  assert.equal(requests.length, 0);
  assert.deepEqual(notesFor(sessionManager), []);
  await session.abort();
  session.clearQueue();
  await session.prompt("unrelated");
  assert.equal(requests.length, 1);
  const notes = notesFor(sessionManager);
  assert.equal(notes.length, 1);
  const { timestamp } = notes[0]!.details as { timestamp: number };
  assert.deepEqual(notes[0]!.details, { moment: "human", kinds: ["reminder", "user"], timestamp });
  assert.deepEqual(notes[0]!.content, [{ type: "text", text: clockAt(timestamp) }, { type: "text", text: "unrelated #2" }]);
  assert.deepEqual(spoken(requests[0]!), ["unrelated", wrapReminder(clockAt(timestamp)), "unrelated #2"]);
  assert.deepEqual(errors, []);
});

test("Pi preserves ordered persistent carriers in every moment and a temporary assistant/user pair", async (t) => {
  const { session, sessionManager, requests, errors, readNext } = await setupSdk(t, `
    export function perception(moment) {
      if (moment.kind === 'human' && moment.text === 'temporary') return [
        { kind: 'assistant', text: 'temporary answer', ephemeral: true },
        { kind: 'user', text: 'temporary follow-up', ephemeral: true },
      ];
      if (moment.kind === 'human' && moment.text === 'tail') return [{ kind: 'assistant', text: 'bare tail', ephemeral: true }];
      if (moment.kind === 'human' && moment.text === 'invalid') return [
        { kind: 'user', text: 'must not persist' }, { kind: 'assistant', text: 'invalid', sink: 1 },
      ];
      if (moment.kind === 'tool' && moment.phase !== 'after') return [];
      return [
        { kind: 'reminder', text: moment.kind + ' cue' },
        { kind: 'assistant', text: moment.kind + ' answer' },
        { kind: 'user', text: moment.kind + ' follow-up', ephemeral: false },
      ];
    }
  `);
  readNext("call");
  await session.prompt("run tool");
  const cues = (index: number, prefix: string) => requestText(requests[index]!).filter((text) => text.includes(prefix + " "));
  const expected = (kind: string) => [wrapReminder(`${kind} cue`), `${kind} answer`, `${kind} follow-up`];
  assert.deepEqual(cues(0, "wake"), expected("wake"));
  assert.deepEqual(cues(0, "human"), expected("human"));
  const human = notesFor(sessionManager).find((entry) => (entry.details as { moment: string }).moment === "human")!;
  const { timestamp } = human.details as { timestamp: number };
  assert.deepEqual(requestText(requests[0]!).slice(-5), ["run tool", wrapReminder(clockAt(timestamp)), ...expected("human")]);
  const toolTail = requests[1]!.slice(-4);
  assert.deepEqual(toolTail.map(({ role }) => role), ["toolResult", "user", "assistant", "user"]);
  assert.deepEqual(requestText(toolTail.slice(1)), expected("tool"));
  assert.deepEqual(toolTail[2], {
    role: "assistant", content: [{ type: "text", text: "tool answer" }], timestamp: toolTail[2]!.timestamp,
    api: "pi-souls", provider: "pi-souls", model: "synthetic", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });

  await session.prompt("temporary");
  assert.deepEqual(requests[2]!.slice(-3).map(({ role }) => role), ["user", "assistant", "user"]);
  assert.deepEqual(requestText(requests[2]!).slice(-3), ["temporary", "temporary answer", "temporary follow-up"]);
  await session.prompt("tail");
  assert.equal(requests[3]!.at(-1)?.role, "assistant");
  assert.equal(requestText(requests[3]!).at(-1), "bare tail");
  await session.prompt("invalid");
  const unwanted = ["temporary answer", "temporary follow-up", "bare tail", "must not persist"];
  assert.deepEqual(spoken(requests[4]!).filter((text) => unwanted.includes(text)), []);
  assert.deepEqual(notesFor(sessionManager).map(({ content, details }) => [content, details]), [
    ["wake cue", { kind: "reminder", moment: "wake" }],
    ["wake answer", { kind: "assistant", moment: "wake" }],
    ["wake follow-up", { kind: "user", moment: "wake" }],
    [[clockAt(timestamp), "human cue", "human answer", "human follow-up"].map((text) => ({ type: "text", text })),
      { kinds: ["reminder", "reminder", "assistant", "user"], moment: "human", timestamp }],
    ["tool cue", { kind: "reminder", moment: "tool" }],
    ["tool answer", { kind: "assistant", moment: "tool" }],
    ["tool follow-up", { kind: "user", moment: "tool" }],
  ]);
  assert.deepEqual(spoken(sessionManager.buildSessionContext().messages).filter((text) => unwanted.includes(text)), []);
  assert.deepEqual(errors, []);
});

test("Pi SDK carries startup ephemeral through a run and places both tool phases after a serial tool batch", async (t) => {
  const { session, sessionManager, requests, errors, readNext } = await setupSdk(t, `
    let toolMoments = 0;
    export function perception(moment) {
      if (moment.kind === 'wake' && moment.source === 'startup') return [{ kind: 'reminder', ephemeral: true, text: 'startup ephemeral' }];
      if (moment.kind === 'tool') return [{ kind: 'reminder', ephemeral: true, text: 'tool ephemeral ' + ++toolMoments + ' ' + moment.phase }];
      return [];
    }
  `);
  session.agent.toolExecution = "sequential";
  readNext("read-1", "read-2");
  await session.prompt("run tools");
  assert.equal(requests.length, 2);
  const transcript = (index: number) => requests[index]!.filter((message) => message.role !== "system");
  for (const i of [0, 1]) {
    assert.equal(transcript(i)[0]?.role, "user");
    assert.equal(transcript(i)[0]?.content, wrapReminder("startup ephemeral"));
  }
  const toolSpeech = ["1 before", "2 after", "3 before", "4 after"].map((label) => wrapReminder(`tool ephemeral ${label}`));
  assert.deepEqual(spoken(requests[0]!).filter((text) => toolSpeech.includes(text)), []);
  const continuation = transcript(1);
  const call = continuation.findIndex((message) => message.role === "assistant");
  assert.ok(call >= 0);
  assert.deepEqual(continuation.slice(call + 1).map((message) => [message.role, message.role === "toolResult" ? message.toolCallId : message.content]), [
    ["toolResult", "read-1"], ["toolResult", "read-2"], ...toolSpeech.map((text) => ["user", text]),
  ]);
  await session.prompt("next run");
  const transient = [wrapReminder("startup ephemeral"), ...toolSpeech];
  assert.deepEqual(spoken(requests[2]!).filter((text) => transient.includes(text)), []);
  assert.deepEqual(spoken(sessionManager.buildSessionContext().messages).filter((text) => transient.includes(text)), []);
  assert.deepEqual(errors, []);
});

test("Pi SDK pins sunk human ephemerals across tool loops and expires them independently", async (t) => {
  const { session, sessionManager, requests, errors, readNext } = await setupSdk(t, `
    export function perception(moment) {
      if (moment.kind !== 'human') return [];
      if (moment.text === 'plant') return [{ kind: 'reminder', ephemeral: true, text: '  pinned note  ', linger: 2, sink: 1 }];
      if (moment.text === 'later') return [{ kind: 'reminder', ephemeral: true, text: 'head note', linger: 2, sink: 100 }];
      return [];
    }
  `);
  const pinned = wrapReminder("  pinned note  ");
  const head = wrapReminder("head note");
  await session.prompt("seed");
  sessionManager.appendCustomEntry("test:invisible", {}); // Not a sink step.
  for (const prompt of ["plant", "later"]) {
    const start = requests.length;
    readNext(`read-${prompt}`);
    await session.prompt(prompt);
    const run = requests.slice(start);
    assert.equal(run.length, 2);
    assert.ok(run[1]!.some((message) => message.role === "toolResult"));
    for (const request of run) {
      const text = requestText(request.filter((message) => message.role !== "system"));
      const seedReply = text.indexOf("Done");
      assert.ok(seedReply >= 0);
      assert.deepEqual(text.slice(seedReply + 1, seedReply + 3), [pinned, "plant"]);
      assert.equal(text.filter((message) => message === pinned).length, 1);
      if (prompt === "later") assert.equal(text[0], head);
    }
  }
  await session.prompt("head only");
  const remaining = requestText(requests.at(-1)!.filter((message) => message.role !== "system"));
  assert.equal(remaining[0], head);
  assert.ok(!remaining.includes(pinned));
  await session.prompt("all expired");
  const expired = requestText(requests.at(-1)!);
  assert.ok(!expired.includes(pinned) && !expired.includes(head));
  assert.deepEqual(notesFor(sessionManager).map((entry) => (entry.details as { kinds: string[] }).kinds), [["reminder"]]);
  assert.deepEqual(spoken(sessionManager.buildSessionContext().messages).filter((text) => text === pinned || text === head || text === "  pinned note  " || text === "head note"), []);
  assert.deepEqual(errors, []);
});

test("Pi SDK sinks tool ephemerals without separating a call from its result", async (t) => {
  const { session, requests, errors, readNext } = await setupSdk(t, `
    export function perception(moment) {
      if (moment.kind !== 'tool') return [];
      if (moment.phase === 'before' && moment.filePath.endsWith('/input.txt')) {
        return [{ kind: 'reminder', ephemeral: true, text: 'before tool note', sink: 1 }];
      }
      if (moment.phase === 'after' && moment.filePath.endsWith('/SOUL.md')) {
        return [{ kind: 'reminder', ephemeral: true, text: 'after tool note', sink: 1 }];
      }
      return [];
    }
  `);
  await session.prompt("seed");
  session.agent.toolExecution = "sequential";
  readNext("read-1", "read-2");
  await session.prompt("run tool");
  const continuation = requests.at(-1)!;
  const user = requestText(continuation).indexOf("run tool");
  assert.ok(user >= 0);
  assert.deepEqual(continuation.slice(user + 1).map(({ role }) => role), ["user", "assistant", "toolResult", "toolResult", "user"]);
  assert.equal(continuation[user + 1]!.content, wrapReminder("before tool note"));
  assert.equal(continuation.at(-1)!.content, wrapReminder("after tool note"));
  assert.deepEqual(errors, []);
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
  const human = async (prompt: string, customPrompt?: string) =>
    (await fire("before_agent_start", { messageType: "user", prompt, systemPromptOptions: { cwd: dir, customPrompt } }) as BeforeAgentStartEventResult | undefined)?.message;
  return {
    dir, dirs: dir, session, sent, messageRenderers, notices, ctx, fire, human, command,
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

test("Pi resolves an ephemeral on an unmapped carrier without splitting results that are not adjacent", async () => {
  const h = setup({
    "faye/SOUL.md": "Faye",
    "faye/perception.ts": "export const perception = () => [{ kind: 'user', ephemeral: true, text: 'after the batch' }];",
  });
  try {
    h.session.appendMessage({ role: "assistant", stopReason: "toolUse", content: ["one", "two"].map((id) => ({
      type: "toolCall", id, name: "read", arguments: {},
    })), timestamp: 1 } as AssistantMessage);
    for (const id of ["one", "two"]) {
      if (id === "two") {
        h.session.appendCustomMessageEntry(PERCEPTION_MESSAGE_TYPE, "carrier", false, { kind: "assistant" });
        await h.fire("tool_call", { toolCallId: "two", toolName: "read", input: {} });
        const event = { messages: h.session.buildSessionContext().messages };
        const open = await h.fire("context", event) as typeof event;
        assert.equal(open.messages.at(-1)?.role, "assistant");
        assert.deepEqual(spoken(open.messages), ["carrier"]);
      }
      h.session.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp: 2 });
    }
    const event = { messages: h.session.buildSessionContext().messages };
    const closed = await h.fire("context", event) as typeof event;
    assert.deepEqual(closed.messages.map(({ role }) => role), ["assistant", "toolResult", "assistant", "toolResult", "user"]);
    const last = closed.messages.at(-1);
    assert.equal(last?.role === "user" && last.content, "after the batch");
  } finally { h.restore(); }
});

test("Pi skips an unclosed tool batch and never pairs a later turn's reused tool ID", async () => {
  for (const closeFirst of [false, true]) {
    const h = setup({
      "faye/SOUL.md": "Faye",
      "faye/perception.ts": "export const perception = () => [{ kind: 'user', ephemeral: true, text: 'first batch note' }];",
    });
    try {
      const call = (ids: string[], timestamp: number) => h.session.appendMessage({
        role: "assistant", stopReason: "toolUse", timestamp,
        content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
      } as AssistantMessage);
      const result = (toolCallId: string, timestamp: number) => h.session.appendMessage({
        role: "toolResult", toolCallId, toolName: "read", content: [], isError: false, timestamp,
      });
      call(["one", "two"], 1);
      result("one", 2);
      await h.fire("tool_call", { toolCallId: "two", toolName: "read", input: {} });
      if (closeFirst) result("two", 3);
      h.session.appendMessage({ role: "user", content: "next native turn", timestamp: 4 });
      const messages = () => h.session.buildSessionContext().messages;
      if (!closeFirst) assert.equal(await h.fire("context", { messages: messages() }), undefined);
      call(["one", "two"], 5);
      result("one", 6);
      result("two", 7);
      const original = messages();
      const projected = await h.fire("context", { messages: original });
      assert.deepEqual(projected, closeFirst
        ? { messages: [...original.slice(0, 3), { role: "user", content: "first batch note", timestamp: 2 }, ...original.slice(3)] }
        : undefined);
    } finally { h.restore(); }
  }
});

test("Pi never moves an ephemeral to a later user when compaction drops its anchor", async () => {
  const h = setup({
    "faye/SOUL.md": "Faye",
    "faye/perception.ts": "export const perception = () => [{ kind: 'reminder', ephemeral: true, text: 'transient', linger: 2 }];",
  });
  try {
    const opener = { role: "user", content: "opening prompt", timestamp: 1 } as const;
    const follow = { role: "user", content: "later user", timestamp: 2 } as const;
    await h.human(opener.content);
    h.session.appendMessage(opener);
    const followId = h.session.appendMessage(follow);
    const messages = [opener, follow];
    assert.deepEqual(await h.fire("context", { messages }), {
      messages: [opener, { role: "user", content: wrapReminder("transient"), timestamp: opener.timestamp }, follow],
    });
    await h.fire("agent_settled");
    h.session.appendCompaction("summary", followId, 100);
    assert.equal(await h.fire("context", { messages: h.session.buildSessionContext().messages }), undefined);
  } finally {
    h.restore();
  }
});

test("Pi anchors a compaction wake ephemeral to the summary, not the system checkpoint", async () => {
  const h = setup({
    "faye/SOUL.md": "Faye",
    "faye/perception.ts": "export const perception = ({ source }) => source === 'compact' ? [{ kind: 'reminder', ephemeral: true, text: 'compact wake' }] : [];"
  });
  try {
    h.session.appendMessage({ role: "system", content: "checkpoint", timestamp: 1 });
    const kept = { role: "user", content: "kept message", timestamp: 2 } as const;
    const keptId = h.session.appendMessage(kept);
    h.session.appendCompaction("summary", keptId, 100);
    await h.fire("session_compact");
    const [checkpoint, summary] = h.session.buildSessionContext().messages;
    assert.equal(checkpoint?.role, "system");
    assert.equal(summary?.role, "compactionSummary");
    assert.deepEqual(await h.fire("context", { messages: structuredClone([summary, kept]) }), {
      messages: [summary, { role: "user", content: wrapReminder("compact wake"), timestamp: summary.timestamp }, kept],
    });
  } finally {
    h.restore();
  }
});

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

test("one invalid utterance rejects the whole batch", () => {
  const persistent = { kind: "user", text: "kept", ephemeral: false };
  const ephemeral = { kind: "assistant", text: "temporary", ephemeral: true, linger: 2, sink: 0 };
  assert.deepEqual(utterances([persistent, ephemeral]), [persistent, ephemeral]);
  assert.deepEqual(utterances(persistent), []);
  assert.deepEqual(utterances(undefined), []);
  for (const invalid of [
    { kind: "unknown", text: "hi" }, { ...persistent, text: "  " },
    { ...persistent, ephemeral: "true" }, { ...persistent, linger: 1 },
    { kind: "reminder", text: "hi", sink: 1 }, { ...ephemeral, linger: 0 }, { ...ephemeral, sink: 0.5 },
    { ...persistent, raw: undefined }, Object.assign(Object.create({ raw: false }), ephemeral),
  ]) assert.deepEqual(utterances([persistent, invalid]), []);
  const hiddenInvalid = [persistent, { ...ephemeral, raw: true }];
  hiddenInvalid[Symbol.iterator] = () => [persistent].values();
  assert.deepEqual(utterances(hiddenInvalid), []);
});

test("a perception module answers, and every failure stays silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-perception-module-"));
  try {
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
    write("speaks.ts", "export function perception(moment, world) { return [{ kind: 'reminder', text: `${moment.kind}:${world.facts.hour}`, extra: 1 }]; }");
    const speaks = loadPerception(join(dir, "speaks.ts"));
    const world = worldFor({ now: new Date(2026, 9, 27, 2, 14, 0).getTime(), sessionId: "s", cwd: "/", soul: "faye" });
    assert.deepEqual(await speaks({ kind: "wake", source: "startup" }, world), [{ kind: "reminder", text: "wake:2" }]);
    write("speaks.ts", "export function perception() { return [{ kind: 'reminder', text: 'fresh instance' }]; }");
    assert.deepEqual(await loadPerception(join(dir, "speaks.ts"))({ kind: "human", text: "hi" }, world), [{ kind: "reminder", text: "fresh instance" }]);
    assert.deepEqual(await speaks({ kind: "wake", source: "startup" }, world), [{ kind: "reminder", text: "wake:2" }]);

    write("default.mjs", "export default () => [{ kind: 'assistant', ephemeral: true, text: 'default export', linger: 2, sink: 1 }];");
    assert.deepEqual(await loadPerception(join(dir, "default.mjs"))({ kind: "human", text: "hi" }, world), [{ kind: "assistant", ephemeral: true, text: "default export", linger: 2, sink: 1 }]);

    write("callable.ts", "module.exports = function perception() { return [{ kind: 'user', text: 'callable' }]; };");
    assert.deepEqual(await loadPerception(join(dir, "callable.ts"))({ kind: "human", text: "hi" }, world), [{ kind: "user", text: "callable" }]);

    write("nothing.ts", "export const perception = () => [];");
    write("throws.ts", "export const perception = () => { throw new Error('boom'); };");
    write("not-a-function.ts", "export const perception = 42;");
    for (const path of ["nothing.ts", "throws.ts", "not-a-function.ts", "missing.ts"]) {
      assert.deepEqual(await loadPerception(join(dir, path))({ kind: "human", text: "hi" }, world), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const wakePerception = "export function perception(moment, world) {\n"
  + "  const base = { now: world.now, sessionId: world.sessionId, cwd: world.cwd, storeDir: world.storeDir, facts: world.facts, absence: world.absenceMs ?? null };\n"
  + "  return [{ kind: 'reminder', text: JSON.stringify({ moment, base }) }];\n"
  + "}\n";

test("Pi wakes the soul through its perception and hands it accurate world facts", async () => {
  const now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  await withTime(now, async (h) => {
    h.session.appendMessage({ role: "user", content: "earlier", timestamp: now - 90_000 });
    await h.fire("session_start", { type: "session_start", reason: "resume" });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.customType, "pi-souls:perception");
    assert.equal(h.sent[0]!.display, true);
    assert.deepEqual(h.sent[0]!.details, { kind: "reminder", moment: "wake" });
    const said = JSON.parse(h.sent[0]!.content);
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
      assert.deepEqual(JSON.parse(h.sent.at(-1)!.content).moment, { kind: "wake", source });
    }
    await h.fire("session_compact", { type: "session_compact" });
    assert.deepEqual(JSON.parse(h.sent.at(-1)!.content).moment, { kind: "wake", source: "compact" });
  }, files);
});

test("/soul reload revalidates the SOUL and its fragments, then reimports the perception", async () => {
  const files = {
    "faye/SOUL.md": "---\nicon: 🦈\n---\nSoul v1 {% render 'parts/shared' %}",
    "parts/shared.md": "original",
    "faye/perception.ts": `export function perception(moment) { return [{ kind: 'reminder', text: "r1:" + moment.source }]; }`,
  };
  await withTime(1_700_000_000_000, async (h) => {
    const before = h.session.getBranch().length;
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /No soul to reload/);
    assert.equal(h.session.getBranch().length, before);

    await h.command.handler("@faye", h.ctx);
    const selected = h.session.getBranch().length;
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.sent.at(-1)!.content, "r1:startup");
    assert.equal(h.footer(), "🦈");

    // Neither a broken SOUL nor a broken fragment may evict the working module.
    h.write("faye/SOUL.md", " ");
    h.write("faye/perception.ts", `export function perception(moment) { return [{ kind: 'reminder', text: "r2:" + moment.source }]; }`);
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /Soul "faye" is empty/);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "r1:compact");
    h.write("faye/SOUL.md", "Soul {% render 'parts/shared' %}");
    h.write("parts/shared.md", "{{ missing }}");
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /Soul "faye" template/);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "r1:compact");

    h.write("parts/shared.md", "SHARED {{ model.id }}");
    h.write("faye/SOUL.md", "---\nicon: 🦊\n---\nSoul v2 {% render 'parts/shared' %}");
    const sentBeforeReload = h.sent.length;
    await h.command.handler("reload", h.ctx);
    assert.match(h.notices.at(-1)!, /Reloaded faye/);
    assert.equal(h.footer(), "🦊");
    assert.equal(h.sent.length, sentBeforeReload); // No perception or model turn from the command.
    assert.equal(h.session.getBranch().length, selected); // No divider or new selection.
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "r2:compact");
  }, files, { defaultSoul: undefined });
});

test("/soul reload refreshes CommonJS perceptions without evicting other souls", async () => {
  const code = (text: string) => `exports.perception = () => [{ kind: 'reminder', text: '${text}' }];`;
  const files = {
    "package.json": '{"type":"commonjs"}',
    "faye/SOUL.md": "Faye", "faye/perception.js": code("f1"),
    "other/SOUL.md": "Other", "other/perception.js": code("o1"),
  };
  await withTime(1_700_000_000_000, async (h) => {
    await h.command.handler("@other", h.ctx);
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    assert.equal(h.sent.at(-1)!.content, "o1");
    await h.command.handler("@faye", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "f1");

    h.write("faye/perception.js", code("f2"));
    h.write("other/perception.js", code("o2"));
    await h.command.handler("reload", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "f2");

    // A missing entry still invalidates the soul's old cached perception.
    rmSync(join(h.dir, "faye/perception.js"));
    await h.command.handler("reload", h.ctx);
    h.write("faye/perception.js", code("f3"));
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "f3");

    await h.command.handler("@other", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "o1");
    await h.command.handler("reload", h.ctx);
    await h.fire("session_compact", { type: "session_compact" });
    assert.equal(h.sent.at(-1)!.content, "o2");
  }, files);
});

test("Pi drops delayed and failed ephemeral without blocking the clock or sending it later", { timeout: 5_000 }, async () => {
  await withTime(1_700_000_000_000, async (h) => {
    const start = performance.now();
    const slow = await h.human("slow answer");
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 1900 && elapsed < 3000, `took ${elapsed} ms`);
    const clock = [{ type: "text", text: clockAt(Date.now()) }];
    assert.deepEqual(slow?.content, clock);
    const user = { role: "user", content: "slow answer", timestamp: Date.now() } as const;
    h.session.appendMessage(user);
    assert.equal(await h.fire("context", { messages: [user] }), undefined);
    // Let the soul finish after the host has gone ahead with the clock alone.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await h.fire("context", { messages: [user] }), undefined);
    assert.deepEqual((await h.human("throw"))?.content, clock);
    assert.equal(await h.fire("context", { messages: [user] }), undefined);
    assert.deepEqual(h.sent, []);
  }, {
    "faye/SOUL.md": "Directory faye",
    "faye/perception.ts": `export const perception = async (moment) => {
      if (moment.text === 'throw') throw new Error('boom');
      await new Promise((r) => setTimeout(r, 2300));
      return [{ kind: 'reminder', ephemeral: true, text: 'too late' }];
    };`,
  }, { timeaware: true });
});

test("Pi answers tool calls before and after, carrying category, path and result", async () => {
  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "/work/a.md" } });
    assert.equal(h.sent.at(-1)!.display, true);
    assert.equal(h.notices.length, 0);
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
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception });
});

test("Pi builtin and directory perceptions share a human moment and fail independently", async () => {
  const now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  await withTime(now, async (h) => {
    const batch = await h.human("hi");
    assert.deepEqual(batch?.details, { kinds: ["reminder", "reminder"], moment: "human", timestamp: now });
    const [clock, directory] = textBlocks(batch!.content);
    assert.equal(clock, clockAt(now));
    const said = JSON.parse(directory!);
    assert.deepEqual(said.moment, { kind: "human", text: "hi" });
    assert.equal(said.base.now, now);
    const renderer = h.messageRenderers.get(PERCEPTION_MESSAGE_TYPE)!;
    const rendered = renderer(
      { customType: PERCEPTION_MESSAGE_TYPE, content: wrapReminder("⌚ 02:14 · Tue, Oct 27\n(1h since *human* was last present)") },
      { expanded: false, outputPad: 1 },
      { fg: (_tone: string, text: string) => text },
    );
    assert.deepEqual(rendered.render(80).map((line: string) => line.trimEnd()), [
      "  ⌚ 02:14 · Tue, Oct 27",
      "  (1h since *human* was last present)",
    ]);

    const multiLine = wrapReminder("[some other faye]\n\n*pokes screen* `` [too slow] ``\n\"hey copy\"\nline 4");
    const folded = renderer(
      { customType: PERCEPTION_MESSAGE_TYPE, content: multiLine },
      { expanded: false, outputPad: 1 },
      { fg: (_tone: string, text: string) => text },
    );
    assert.deepEqual(folded.render(120).map((line: string) => line.trimEnd()), [
      "  [some other faye]",
      "",
      "  *pokes screen* `` [too slow] ``",
      "  ━━──",
    ]);
    const unfolded = renderer(
      { customType: PERCEPTION_MESSAGE_TYPE, content: multiLine },
      { expanded: true, outputPad: 1 },
      { fg: (_tone: string, text: string) => text },
    );
    assert.deepEqual(unfolded.render(120).map((line: string) => line.trimEnd()), [
      "  [some other faye]",
      "",
      "  *pokes screen* `` [too slow] ``",
      "  \"hey copy\"",
      "  line 4",
      "  ━━━━ ▴",
    ]);
    // A failed soul render suppresses the clock, while its independent module can still answer.
    h.write("faye/SOUL.md", "{{ missing }}");
    const afterFailure = await h.human("again");
    assert.deepEqual(afterFailure?.details, { kinds: ["reminder"], moment: "human" });
  }, { "faye/SOUL.md": "Faye", "faye/perception.ts": wakePerception }, { timeaware: true });

  await withTime(now, async (h) => {
    assert.deepEqual((await h.human("hi"))?.content, [{ type: "text", text: clockAt(now) }]);
  }, { "faye/SOUL.md": "Faye", "faye/perception.ts": "export const perception = () => { throw new Error('boom'); };" }, { timeaware: true });
});

test("Pi renders literal reminder tags from each text block in a human batch", async () => {
  const literals = ["first", "second"].map((text) => `<system-reminder>\n${text}\n</system-reminder>`);
  const h = setup({
    "faye/SOUL.md": "Directory faye",
    "faye/perception.ts": `export const perception = () => ${JSON.stringify(literals.map((text) => ({ kind: "user", text })))};`,
  });
  try {
    const carrier = await h.human("hi");
    assert.ok(carrier);
    const render = h.messageRenderers.get(PERCEPTION_MESSAGE_TYPE)!;
    const component = render(carrier, { expanded: true }, { fg: (_tone: string, text: string) => text });
    const formatShort = (text: string) => text.split("\n");
    assert.deepEqual(
      component.render(80).map((line: string) => line.trim()),
      [
        ...formatShort(literals[0]!),
        "",
        ...formatShort(literals[1]!),
      ],
    );
  } finally { h.restore(); }
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
    assert.equal(await h.fire("before_agent_start", {
      messageType: "user", prompt: "hi", systemPromptOptions: { cwd: h.dir, customPrompt: "My own prompt" },
    }), undefined);
    assert.equal(h.sent.length, 0);
    assert.equal(h.notices.length, 0);
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": wakePerception }, { defaultSoul: "faye" });

  await withTime(1_700_000_000_000, async (h) => {
    await h.fire("session_start", { type: "session_start", reason: "startup" });
    await h.fire("tool_call", { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } });
    assert.equal(h.sent.length, 0);
  }, { "faye/SOUL.md": "Directory faye", "faye/perception.ts": "export const perception = () => { throw new Error('boom'); };" });
});
