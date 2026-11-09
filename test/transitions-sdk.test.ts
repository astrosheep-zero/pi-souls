import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { TRANSITION_ENTRY_TYPE } from "../src/transitions.ts";
import { sessionSoul } from "../src/souls.ts";

const CLOCK = "<system-reminder>\n⌚ 15:04\n</system-reminder>";
const CLOCK_TYPE = "test:clock";
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

function reply(model: Model<Api>, toolCallId?: string) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: toolCallId ? [{ type: "toolCall", id: toolCallId, name: "probe", arguments: {} }] : [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: toolCallId ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: output });
  stream.push({ type: "done", reason: toolCallId ? "toolUse" : "stop", message: output });
  stream.end();
  return stream;
}

function clockExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", () => ({
    message: { customType: CLOCK_TYPE, content: CLOCK, display: true, details: { timestamp: 1 } },
  }));
}

function text(message: { content: string | readonly { type: string; text?: string }[] }): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => block.type === "text" ? block.text ?? "" : "").join("");
}

function fresh<T extends { role: string }>(messages: readonly T[]): readonly T[] {
  return messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
}

const BRAIN = "<system-reminder>\nnew brain: beta\n</system-reminder>";
const SOUL = "<system-reminder>\nnew soul: reviewer\n</system-reminder>";

/** Cache contract: only the system prompt may change; every earlier message keeps its place. */
function assertStablePrefix(requests: readonly (readonly { role: string }[])[]) {
  const kept = (messages: readonly { role: string }[]) => messages
    .filter((message) => message.role !== "system")
    .map((message) => JSON.stringify(message));
  for (let i = 1; i < requests.length; i++) {
    const previous = kept(requests[i - 1]!);
    assert.deepEqual(kept(requests[i]!).slice(0, previous.length), previous);
  }
}

async function setup(downstream?: (pi: ExtensionAPI) => void, overrides: { souls?: Record<string, string>; errors?: string[]; toolCalls?: number; onTool?: () => Promise<void>; persistent?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "transitions-sdk-"));
  const agentDir = join(home, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(home, "faye.md"), "Faye");
  writeFileSync(join(home, "reviewer.md"), "Reviewer");
  const requests: TranscriptContext["messages"][] = [];
  const settings = SettingsManager.inMemory({
    soulsDir: home,
    modelSouls: overrides.souls ?? { "fake/alpha": "faye", "fake/beta": "reviewer" },
    compaction: { enabled: false },
    retry: { enabled: false },
  } as any);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("fake", {
    baseUrl: "https://fake.invalid",
    apiKey: "fake-key",
    api: "fake-api" as Api,
    models: [
      { id: "alpha", name: "Alpha", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096 },
      { id: "beta", name: "Beta", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096 },
    ],
    streamSimple: (model: Model<Api>, context: TranscriptContext, _options?: SimpleStreamOptions) => {
      requests.push(structuredClone(context.messages));
      return reply(model, requests.length > 1 && requests.length <= 1 + (overrides.toolCalls ?? 0) ? `call-${requests.length}` : undefined);
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: home,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [extension, clockExtension, ...(downstream ? [downstream] : [])],
  });
  await loader.reload();
  const sessionManager = overrides.persistent ? SessionManager.create(home, join(home, "sessions")) : SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: home,
    agentDir,
    model: modelRuntime.getModel("fake", "alpha")!,
    modelRuntime,
    settingsManager: settings,
    sessionManager,
    resourceLoader: loader,
    noTools: "builtin",
    customTools: [{
      name: "probe", label: "Probe", description: "Return a tool result",
      parameters: { type: "object", properties: {} } as any,
      execute: async () => {
        await overrides.onTool?.();
        return { content: [{ type: "text", text: "probe output" }], details: undefined };
      },
    }],
  });
  if (overrides.errors) {
    const errors = overrides.errors;
    await session.bindExtensions({ onError: (error) => errors.push(`${error.event}: ${error.error}`) });
  }
  return {
    home, session, sessionManager, requests,
    beta: modelRuntime.getModel("fake", "beta")!,
    cleanup: () => { session.dispose(); rmSync(home, { recursive: true, force: true }); },
  };
}

test("Pi SDK appends each identity notice once and never rewrites earlier messages", async () => {
  const s = await setup();
  try {
    await s.session.prompt("first");
    assert.equal(s.requests.length, 1);
    assert.ok(!s.requests[0]!.some((message) => text(message).includes("new brain:")));

    await s.session.setModel(s.beta);
    await s.session.sendCustomMessage({ customType: "test:nudge", content: "nudge", display: false }, { triggerTurn: true });
    assert.equal(s.requests.length, 2);
    const brainAt = s.requests[1]!.map(text).indexOf(BRAIN);
    assert.ok(brainAt >= 0);
    assert.ok(!s.requests[1]!.some((message) => text(message).includes("new soul:")));

    await s.session.prompt("second");
    const second = s.requests[2]!.map(text);
    assert.equal(second.filter((entry) => entry === BRAIN).length, 1);
    assert.equal(second.indexOf(BRAIN), brainAt, "the brain notice keeps the place it was sent at");
    assert.ok(!second.some((entry) => entry.includes("new soul:")), "the soul notice settles after this run");
    assert.equal(fresh(s.requests[2]!).map(text).filter((entry) => entry === CLOCK).length, 1);
    assertStablePrefix(s.requests);

    const clock = s.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === CLOCK_TYPE) as CustomMessageEntry;
    assert.equal(clock.display, true);
    assert.equal(clock.content, CLOCK);
    const notes = s.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-souls:transition-reminder") as CustomMessageEntry[];
    assert.deepEqual(notes.map((entry) => entry.content), [BRAIN, SOUL]);
    assert.ok(notes.every((entry) => entry.display === false));
    const snapshots = s.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TRANSITION_ENTRY_TYPE) as CustomEntry[];
    assert.deepEqual(snapshots.at(-1)!.data, { version: 1, model: { provider: "fake", id: "beta" }, soul: "reviewer" });

    await s.session.prompt("third");
    const third = s.requests[3]!.map(text);
    assert.equal(third.filter((entry) => entry === BRAIN).length, 1);
    assert.equal(third.filter((entry) => entry === SOUL).length, 1);
    assert.ok(third.indexOf(SOUL) < third.indexOf("third"));
    assertStablePrefix(s.requests);
  } finally { s.cleanup(); }
});

test("Pi SDK clear removes the projected soul across model changes and persists until reset", async () => {
  const s = await setup(undefined, { persistent: true });
  const preamble = () => {
    const message = s.requests.at(-1)!.find((message) => message.role === "system");
    assert.ok(message?.role === "system");
    return message.sections?.preamble;
  };
  try {
    await s.session.prompt("first");
    assert.equal(preamble(), "Faye");
    await s.session.prompt("/soul clear");
    assert.equal(s.requests.length, 1); // A command never starts a provider request.
    await s.session.prompt("after clear");
    const original = preamble();
    assert.ok(original && original !== "Faye" && original !== "Reviewer");
    const file = s.sessionManager.getSessionFile()!;
    assert.equal(sessionSoul(SessionManager.open(file).getBranch()), null);

    await s.session.setModel(s.beta);
    await s.session.prompt("after model switch");
    assert.equal(preamble(), original);
    await s.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    await s.session.prompt("after resume");
    assert.equal(preamble(), original);

    await s.session.prompt("/soul reset");
    assert.equal(s.requests.length, 4);
    assert.equal(sessionSoul(SessionManager.open(file).getBranch()), undefined);
    await s.session.prompt("defaults again");
    assert.equal(preamble(), "Reviewer");

    await s.session.prompt("/soul clear");
    await s.session.prompt("/soul @faye");
    await s.session.prompt("manual selection");
    assert.equal(preamble(), "Faye");
  } finally { s.cleanup(); }
});

test("Pi SDK reads the final live customPrompt before claiming a soul", async () => {
  const control = { suppress: false };
  const downstream = (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      if (control.suppress) event.systemPromptOptions.customPrompt = "custom";
    });
  };
  const s = await setup(downstream);
  try {
    await s.session.prompt("first");
    await s.session.setModel(s.beta);

    control.suppress = true;
    await s.session.prompt("second");
    const suppressed = s.requests[1]!.map(text);
    assert.ok(suppressed.includes(BRAIN));
    assert.ok(!suppressed.some((entry) => entry.includes("new soul:")));

    control.suppress = false;
    await s.session.prompt("third");
    await s.session.prompt("fourth");
    const sent = s.requests.at(-1)!.map(text);
    assert.equal(sent.filter((entry) => entry === SOUL).length, 1);
    assertStablePrefix(s.requests);
  } finally { s.cleanup(); }
});

test("no-UI: a failed soul load surfaces an error and still emits the brain-only reminder", async () => {
  const errors: string[] = [];
  const s = await setup(undefined, { souls: { "fake/alpha": "faye", "fake/beta": "missing" }, errors });
  try {
    await s.session.prompt("first");
    await s.session.setModel(s.beta);

    await s.session.prompt("second");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^context_with_system: Soul "missing" not found/);
    assert.equal(s.session.extensionRunner.hasUI(), false);

    const sent = s.requests[1]!.map(text);
    assert.equal(sent.filter((entry) => entry === BRAIN).length, 1);
    assert.ok(!sent.some((entry) => entry.includes("new soul:")));
    const snapshots = s.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TRANSITION_ENTRY_TYPE) as CustomEntry[];
    assert.deepEqual(snapshots.at(-1)!.data, { version: 1, model: { provider: "fake", id: "beta" }, soul: "faye" });

    writeFileSync(join(s.home, "missing.md"), "Missing");
    await s.session.prompt("third");
    await s.session.prompt("fourth");
    assert.equal(errors.length, 1);
    const note = "<system-reminder>\nnew soul: missing\n</system-reminder>";
    assert.equal(s.requests.at(-1)!.map(text).filter((entry) => entry === note).length, 1);
    assertStablePrefix(s.requests);
  } finally { s.cleanup(); }
});

test("Pi SDK never splits a tool call from its result when the model switches mid-run", async () => {
  let switchModel = async () => {};
  const s = await setup(undefined, { toolCalls: 1, onTool: () => switchModel() });
  switchModel = () => s.session.setModel(s.beta);
  try {
    await s.session.prompt("first");
    await s.session.prompt("work");
    // Notices settle after the run's tool results; no request may carry a note between the pair.
    for (const request of s.requests) {
      request.forEach((message, index) => {
        if (message.role !== "assistant") return;
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          const result = request.findIndex((entry) => entry.role === "toolResult" && entry.toolCallId === block.id);
          if (result < 0) continue;
          const between = request.slice(index + 1, result);
          assert.ok(between.every((entry) => entry.role === "toolResult"), "only results sit between a call and its result");
        }
      });
    }
    const sent = s.requests[2]!.map(text);
    assert.equal(sent.filter((entry) => entry === BRAIN).length, 1);
    assertStablePrefix(s.requests);
    await s.session.prompt("after");
    const last = s.requests.at(-1)!.map(text);
    assert.equal(last.filter((entry) => entry === BRAIN).length, 1);
    assert.equal(last.filter((entry) => entry === SOUL).length, 1);
    assertStablePrefix(s.requests);
    const toolResults = s.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    assert.ok(toolResults.every((message) => text(message) === "probe output"));
  } finally { s.cleanup(); }
});

test("Pi SDK keeps a model-change notice at its event through tool-loop requests", async () => {
  const s = await setup(undefined, { toolCalls: 2 });
  try {
    await s.session.prompt("first");
    await s.session.setModel(s.beta);
    await s.session.prompt("second");
    const brainAt = s.requests[1]!.map(text).indexOf(BRAIN);
    assert.ok(brainAt >= 0);
    for (const request of s.requests.slice(1)) {
      const sent = request.map(text);
      assert.equal(sent.filter((value) => value === BRAIN).length, 1);
      assert.equal(sent.indexOf(BRAIN), brainAt, "the brain notice keeps its own place");
      assert.ok(sent.indexOf(BRAIN) < sent.indexOf("second"), "it precedes the prompt that triggered it");
    }
    const toolResults = s.sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
    assert.ok(toolResults.every((message) => text(message) === "probe output"));
    await s.session.prompt("third");
    const last = s.requests.at(-1)!.map(text);
    assert.equal(last.filter((value) => value === BRAIN).length, 1);
    assert.equal(last.filter((value) => value === SOUL).length, 1);
    assertStablePrefix(s.requests);
    assert.ok(!fresh(s.requests.at(-1)!).some((message) => text(message).includes("new brain:")));
  } finally { s.cleanup(); }
});
