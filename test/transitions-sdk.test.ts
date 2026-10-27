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

const CLOCK = "<system-reminder>\n⌚ 15:04\n</system-reminder>";
const CLOCK_TYPE = "test:clock";
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

function reply(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: output });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
  stream.push({ type: "done", reason: "stop", message: output });
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

async function setup(downstream?: (pi: ExtensionAPI) => void, overrides: { souls?: Record<string, string>; errors?: string[] } = {}) {
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
      return reply(model);
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
  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: home,
    agentDir,
    model: modelRuntime.getModel("fake", "alpha")!,
    modelRuntime,
    settingsManager: settings,
    sessionManager,
    resourceLoader: loader,
    noTools: "all",
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

test("Pi SDK sends the hidden transition reminder separately from a visible clock message", async () => {
  const s = await setup();
  try {
    await s.session.prompt("first");
    assert.equal(s.requests.length, 1);
    assert.ok(!fresh(s.requests[0]).some((message) => text(message).includes("new brain:")));

    await s.session.setModel(s.beta);
    await s.session.sendCustomMessage({ customType: "test:nudge", content: "nudge", display: false }, { triggerTurn: true });
    assert.equal(s.requests.length, 2);
    assert.ok(!fresh(s.requests[1]).some((message) => text(message).includes("new brain:")));

    await s.session.prompt("second");
    assert.equal(s.requests.length, 3);
    const reminder = "<system-reminder>\nnew brain: beta\nnew soul: reviewer\n</system-reminder>";
    const sent = fresh(s.requests[2]).map(text);
    assert.equal(sent.filter((entry) => entry === reminder).length, 1);
    assert.equal(sent.filter((entry) => entry === CLOCK).length, 1);
    assert.notEqual(sent.indexOf(reminder), sent.indexOf(CLOCK));

    const clock = s.sessionManager.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === CLOCK_TYPE) as CustomMessageEntry;
    assert.equal(clock.display, true);
    assert.equal(clock.content, CLOCK);
    const snapshots = s.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TRANSITION_ENTRY_TYPE) as CustomEntry[];
    assert.deepEqual(snapshots.at(-1)!.data, { version: 1, model: { provider: "fake", id: "beta" }, soul: "reviewer" });

    await s.session.prompt("third");
    assert.equal(s.requests.length, 4);
    assert.ok(!fresh(s.requests[3]).some((message) => text(message).includes("new brain:")));
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
    const suppressed = fresh(s.requests[1]).map(text);
    assert.ok(suppressed.includes("<system-reminder>\nnew brain: beta\n</system-reminder>"));
    assert.ok(!suppressed.some((entry) => entry.includes("new soul:")));

    control.suppress = false;
    await s.session.prompt("third");
    assert.ok(fresh(s.requests[2]).map(text).includes("<system-reminder>\nnew soul: reviewer\n</system-reminder>"));
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

    const sent = fresh(s.requests[1]).map(text);
    assert.equal(sent.filter((entry) => entry === "<system-reminder>\nnew brain: beta\n</system-reminder>").length, 1);
    assert.ok(!sent.some((entry) => entry.includes("new soul:")));
    const snapshots = s.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TRANSITION_ENTRY_TYPE) as CustomEntry[];
    assert.deepEqual(snapshots.at(-1)!.data, { version: 1, model: { provider: "fake", id: "beta" }, soul: "faye" });

    writeFileSync(join(s.home, "missing.md"), "Missing");
    await s.session.prompt("third");
    assert.equal(errors.length, 1);
    assert.ok(fresh(s.requests[2]).map(text).includes("<system-reminder>\nnew soul: missing\n</system-reminder>"));
  } finally { s.cleanup(); }
});
