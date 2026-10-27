import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { ENTRY_TYPE } from "../src/souls.ts";
import { TRANSITION_ENTRY_TYPE, TRANSITION_MESSAGE_TYPE, readTransition, transitionLines, formatTransitionReminder } from "../src/transitions.ts";

type Settings = Record<string, unknown>;
type Handler = (event: any, ctx: any) => any;
type Reminder = { customType: string; content: string; display: boolean };

function harness(settings: Settings, session = SessionManager.inMemory()) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const pi = {
    registerFlag: () => {},
    getFlag: () => false,
    getSettings: () => settings,
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  const ctx = (model: unknown) => ({
    cwd: settings.soulsDir as string,
    model,
    sessionManager: session,
    hasUI: true,
    isIdle: () => true,
    getSystemPromptOptions: () => ({ cwd: settings.soulsDir }),
    ui: { notify: (text: string, type: string) => notices.push(`${type}: ${text}`), setStatus: () => {} },
  });
  const before = (handler: Handler) => handlers.set("before_agent_start", [...(handlers.get("before_agent_start") ?? []), handler]);
  const request = (model: unknown, customPrompt?: string, messageType?: string) => {
    const c = ctx(model);
    const event = { type: "before_agent_start", prompt: "hi", ...(messageType ? { messageType } : {}), systemPromptOptions: { cwd: settings.soulsDir, customPrompt } };
    for (const handler of handlers.get("before_agent_start") ?? []) handler(event, c);
    const messages: AgentMessage[] = [
      { role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 },
      { role: "user", content: "hi", timestamp: 1 },
    ];
    let out = messages;
    for (const handler of handlers.get("context_with_system") ?? []) {
      const result = handler({ type: "context_with_system", messages: out }, c) as { messages: AgentMessage[] } | undefined;
      if (result) out = result.messages;
    }
    for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled", aborted: false }, c);
    const reminder = out.find((message) => message.role === "custom" && message.customType === TRANSITION_MESSAGE_TYPE) as Reminder | undefined;
    return { reminder, messages: out };
  };
  return { session, request, before, notices };
}

const snapshots = (session: SessionManager) =>
  session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TRANSITION_ENTRY_TYPE);

function soulFile(dir: string, name: string, body = name) {
  writeFileSync(join(dir, `${name}.md`), body);
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), "transitions-"));
}

test("first prompt is silent; simultaneous model and mapped soul change is one hidden reminder, then no repeat", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye", "p/b": "reviewer" } };
    const h = harness(settings);

    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    assert.equal(snapshots(h.session).length, 1);
    assert.deepEqual(readTransition(h.session.getBranch()), { model: { provider: "p", id: "a" }, soul: "faye" });

    const message = h.request({ provider: "p", id: "b" }).reminder!;
    assert.equal(message.customType, TRANSITION_MESSAGE_TYPE);
    assert.equal(message.content, "<system-reminder>\nnew brain: b\nnew soul: reviewer\n</system-reminder>");
    assert.equal(message.display, false);
    assert.equal(snapshots(h.session).length, 2);
    assert.equal(h.request({ provider: "p", id: "b" }).reminder, undefined);
    assert.equal(snapshots(h.session).length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("model-only, soul-only, none-to-soul and provider changes keep only real lines", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, defaultSoul: "faye" };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);

    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");
    assert.equal(h.request({ provider: "q", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");

    settings.defaultSoul = "reviewer";
    assert.equal(h.request({ provider: "q", id: "b" }).reminder?.content, "<system-reminder>\nnew soul: reviewer\n</system-reminder>");

    settings.defaultSoul = undefined;
    assert.equal(h.request({ provider: "q", id: "b" }).reminder, undefined); // active-to-none is silent
    assert.deepEqual(readTransition(h.session.getBranch()), { model: { provider: "q", id: "b" }, soul: null });
    settings.defaultSoul = "faye";
    assert.equal(h.request({ provider: "q", id: "b" }).reminder?.content, "<system-reminder>\nnew soul: faye\n</system-reminder>");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("session clear that resolves the same soul and switch-away-and-back are no-ops", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);

    h.session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: "faye" });
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    h.session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: "reviewer" });
    h.session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: "faye" });
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    const before = snapshots(h.session).length;
    h.session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: "faye" });
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    assert.equal(snapshots(h.session).length, before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a soul that fails to load is never announced; a real brain change still reports", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye", "p/b": "missing" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);

    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");
    assert.deepEqual(readTransition(h.session.getBranch()), { model: { provider: "p", id: "b" }, soul: "faye" });
    assert.match(h.notices.at(-1)!, /Soul "missing" not found/);

    soulFile(home, "missing");
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew soul: missing\n</system-reminder>");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a failed soul projection keeps the old soul and still reports a real brain change", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye", "p/b": "reviewer" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);

    let force = true;
    h.before((event) => {
      event.systemPromptOptions.forceSystemPrompt = force ? "Replacement without the identity" : undefined;
    });
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");
    assert.deepEqual(readTransition(h.session.getBranch()), { model: { provider: "p", id: "b" }, soul: "faye" });
    assert.match(h.notices.at(-1)!, /replacement failed — no preamble/);

    force = false;
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew soul: reviewer\n</system-reminder>");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("baselines are branch-local and survive a fresh extension instance", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    const settings: Settings = { soulsDir: home, defaultSoul: "faye" };
    const session = SessionManager.inMemory();
    const first = harness(settings, session);
    assert.equal(first.request({ provider: "p", id: "a" }).reminder, undefined);
    const baseline = snapshots(session).at(-1)!.id;
    assert.equal(first.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");

    const resumed = harness(settings, session);
    assert.equal(resumed.request({ provider: "p", id: "b" }).reminder, undefined);

    session.branch(baseline);
    assert.equal(resumed.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");
    assert.equal(resumed.request({ provider: "p", id: "b" }).reminder, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("non-user runs neither consume nor advance the Pi baseline", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye", "p/b": "reviewer" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    const before = snapshots(h.session).length;

    assert.equal(h.request({ provider: "p", id: "b" }, undefined, "custom").reminder, undefined);
    assert.equal(snapshots(h.session).length, before);
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\nnew soul: reviewer\n</system-reminder>");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("downstream before_agent_start options decide the soul line", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye", "p/b": "reviewer" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);

    let suppress = true;
    h.before((event) => { if (suppress) event.systemPromptOptions.customPrompt = "custom"; });
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");
    assert.deepEqual(readTransition(h.session.getBranch()), { model: { provider: "p", id: "b" }, soul: null });

    suppress = false;
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew soul: reviewer\n</system-reminder>");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("returning to the delivered baseline after a prompt reports the change again", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    soulFile(home, "reviewer");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye", "p/b": "reviewer" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\nnew soul: reviewer\n</system-reminder>");
    assert.equal(h.request({ provider: "p", id: "a" }).reminder?.content, "<system-reminder>\nnew brain: a\nnew soul: faye\n</system-reminder>");
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("active-to-none is silent but a simultaneous brain change still reports", () => {
  const home = dir();
  try {
    soulFile(home, "faye");
    const settings: Settings = { soulsDir: home, modelSouls: { "p/a": "faye" } };
    const h = harness(settings);
    assert.equal(h.request({ provider: "p", id: "a" }).reminder, undefined);
    settings.modelSouls = {};
    assert.equal(h.request({ provider: "p", id: "b" }).reminder?.content, "<system-reminder>\nnew brain: b\n</system-reminder>");
    assert.deepEqual(readTransition(h.session.getBranch()), { model: { provider: "p", id: "b" }, soul: null });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("transition helpers compare provider plus id and wrap only real lines", () => {
  const base = { model: { provider: "p", id: "a" }, soul: "faye" };
  assert.deepEqual(transitionLines(base, { model: { provider: "p", id: "a" }, soul: "faye" }), []);
  assert.deepEqual(transitionLines(base, { model: { provider: "q", id: "a" }, soul: "faye" }), ["new brain: a"]);
  assert.deepEqual(transitionLines(base, { model: null, soul: null }), []);
  assert.equal(formatTransitionReminder(["new brain: a"], false), "new brain: a");
});
