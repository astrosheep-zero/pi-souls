import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { applySoul, replaceForcedPreamble } from "../src/prompt.ts";
import { ENTRY_TYPE, effectiveSoul, readConfig, resolveSoul, sessionSoul, loadSoul, listSouls, unmatchableModelKeys } from "../src/souls.ts";

const model = { provider: "provider", id: "model" };
const config = readConfig({ defaultSoul: "global", modelSouls: { "provider/model": "specific" } }, "/tmp");

test("session > exact model > default; clear and branch navigation replay from the session", () => {
  const session = SessionManager.inMemory();
  const root = session.appendCustomEntry("unrelated", {});
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model)?.name, "specific");
  session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: "manual" });
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model)?.name, "manual");
  session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: null });
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model)?.name, "specific");
  session.branch(root);
  assert.equal(sessionSoul(session.getBranch()), undefined);
  assert.equal(resolveSoul(config, undefined, { ...model, id: "other" })?.name, "global");
  assert.equal(resolveSoul(readConfig({}, "/tmp"), undefined, model), undefined);
});

test("soulless via CLI or env skips defaults; /soul wins and clear returns to soulless", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-less-"));
  const previous = process.env.SOULLESS;
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let flag = false;
    let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
    const pi = {
      registerFlag: (name: string, options: { type: string }) => {
        assert.equal(name, "soulless"); assert.equal(options.type, "boolean");
      },
      getFlag: () => flag,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = {
      cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
      getSystemPromptOptions: () => ({ cwd: dir }),
      ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    };
    const request = () => handlers.get("context_with_system")!({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx) as { messages: AgentMessage[] } | undefined;

    process.env.SOULLESS = "0";
    assert.ok(request());
    process.env.SOULLESS = "1";
    assert.equal(request(), undefined);
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless\)/);

    process.env.SOULLESS = "0";
    flag = true;
    assert.equal(request(), undefined); // CLI still wins over SOULLESS=0.
    await command.handler("faye", ctx);
    const applied = request()!;
    const head = applied.messages[0];
    assert.ok(head.role === "system");
    assert.equal(head.sections?.preamble, "Faye");
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: faye \(session\)/);
    await command.handler("clear", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless\)/);
    assert.equal(request(), undefined);
    // Suppressed defaults need not even contain a valid name.
    assert.equal(resolveSoul(readConfig({ defaultSoul: 42 }, dir), undefined, model, true), undefined);
  } finally {
    if (previous === undefined) delete process.env.SOULLESS; else process.env.SOULLESS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad setting only fails where it is used", () => {
  const messy = readConfig({ defaultSoul: 42, modelSouls: { "provider/model": "specific", "provider/broken": "../x", typo: "faye" } }, "/tmp");
  assert.equal(resolveSoul(messy, undefined, model)?.name, "specific");
  assert.throws(() => resolveSoul(messy, undefined, { ...model, id: "broken" }), /modelSouls\["provider\/broken"\]/);
  assert.throws(() => resolveSoul(messy, undefined, { ...model, id: "other" }), /defaultSoul/);
  assert.deepEqual(unmatchableModelKeys(messy), ["typo"]);
});

test("loader reads one body, strips metadata, observes edits and rejects unsafe names", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-"));
  try {
    writeFileSync(join(dir, "faye.md"), "---\nname: Faye\n---\nOne body\n");
    assert.deepEqual(listSouls(dir), ["faye"]);
    assert.equal(loadSoul(dir, "faye"), "One body");
    writeFileSync(join(dir, "faye.md"), "Changed");
    assert.equal(loadSoul(dir, "faye"), "Changed");
    assert.throws(() => loadSoul(dir, "../secret"), /Invalid soul/);
    assert.throws(() => loadSoul(dir, "missing"), /Soul "missing" not found/);
    writeFileSync(join(dir, "empty.md"), "  ");
    assert.throws(() => loadSoul(dir, "empty"), /empty/);
    mkdirSync(join(dir, "folder.md"));
    assert.throws(() => loadSoul(dir, "folder"), /Soul "folder" unreadable: .*folder\.md/);
    assert.throws(() => readConfig({ modelSouls: ["faye"] }, dir), /modelSouls must be an object/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projection replaces identity only, including old deltas, without mutating history", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "", sections: { preamble: "Coding assistant", tools: "tools", rules: "rules", docs: "docs", skills: "skills", cwd: "/tmp", project_context: "project", addendum: "append" }, timestamp: 0 },
    { role: "user", content: "hi", timestamp: 1 },
    { role: "system", content: "", sections: { preamble: "old", rules: "new rules" }, timestamp: 2 },
  ];
  const original = structuredClone(messages);
  const result = applySoul(messages, "Faye");
  assert.deepEqual(messages, original);
  assert.equal(result[1], messages[1]);
  for (const index of [0, 2]) {
    const before = original[index]; const after = result[index];
    assert.ok(before.role === "system" && after.role === "system");
    assert.deepEqual(after, { ...before, sections: { ...before.sections, preamble: "Faye" } });
  }
  // Sessions older than system messages declare the prompt after the conversation starts.
  const legacy = applySoul([{ role: "user", content: "hi", timestamp: 0 }, { role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 1 }], "Faye");
  assert.deepEqual(legacy[1], { role: "system", content: "", sections: { preamble: "Faye" }, timestamp: 1 });
  assert.throws(() => applySoul([{ role: "system", content: "plain", timestamp: 0 }], "Faye"), /no preamble/);
});

test("errors are deduplicated; forced prompts report successful replacement only after patching", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-problems-"));
  try {
    const session = SessionManager.inMemory();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye" }),
      registerCommand: () => {},
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const notices: string[] = [];
    const ctx = { cwd: dir, model, sessionManager: session, hasUI: true, ui: { notify: (text: string, type: string) => notices.push(`${type}: ${text}`), setStatus: () => {} } };
    const request = () => handlers.get("context_with_system")!({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx);
    const options: Record<string, unknown> = { cwd: dir };
    handlers.get("before_agent_start")!({ systemPromptOptions: options }, ctx);

    assert.equal(request(), undefined);
    assert.equal(request(), undefined);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^warning: Soul "faye" not found/);
    writeFileSync(join(dir, "faye.md"), "Faye");
    assert.ok(request());

    options.forceSystemPrompt = "Pi\n\nPaseo voice mode is now off."; // A later handler appends text.
    assert.ok(request());
    assert.equal(options.forceSystemPrompt, "Faye\n\nPaseo voice mode is now off.");
    assert.equal(notices.at(-1), "info: Soul: preamble replaced");
    const noticeCount = notices.length;
    assert.ok(request()); // Tool-loop requests must not look for Pi in our patched output.
    assert.equal(notices.length, noticeCount);
    writeFileSync(join(dir, "faye.md"), "New Faye $&");
    assert.ok(request());
    assert.equal(options.forceSystemPrompt, "New Faye $&\n\nPaseo voice mode is now off.");

    options.forceSystemPrompt = "Replacement without the identity";
    assert.equal(request(), undefined);
    assert.equal(notices.at(-1), "warning: Soul: replacement failed — no preamble");
    assert.equal(request(), undefined);
    assert.equal(options.forceSystemPrompt, "Replacement without the identity");

    handlers.get("agent_settled")!({ aborted: false }, ctx);
    assert.ok(request()); // A stale force does not apply after the run.
    ctx.hasUI = false;
    handlers.get("before_agent_start")!({ systemPromptOptions: options }, ctx);
    assert.throws(request, /replacement failed/);
    assert.equal(request(), undefined);

    // Print mode warnings go to stderr, but a compatible force must not throw.
    const warn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (text: string) => warnings.push(text);
      handlers.get("session_start")!({}, ctx);
      handlers.get("before_agent_start")!({ messageType: "custom", systemPromptOptions: options }, ctx);
      options.forceSystemPrompt = "Missing identity";
      assert.throws(request, /replacement failed/);
      assert.equal(warnings.length, 0); // No premature success notice on failure.
      options.forceSystemPrompt = "Pi\n\nExtra instructions";
      assert.ok(request());
      assert.ok(request());
      assert.deepEqual(warnings, ["Soul: preamble replaced"]);
      assert.equal(options.forceSystemPrompt, "New Faye $&\n\nExtra instructions");
    } finally { console.warn = warn; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forced projection uses the latest preamble and preserves surrounding prompt text", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "", sections: { preamble: "Old identity" }, timestamp: 0 },
    { role: "user", content: "hi", timestamp: 1 },
    { role: "system", content: "", sections: { preamble: "Current identity" }, timestamp: 2 },
  ];
  assert.equal(
    replaceForcedPreamble(messages, "Prefix\nCurrent identity\nTools and Paseo addendum", "Soul $& $$"),
    "Prefix\nSoul $& $$\nTools and Paseo addendum",
  );
  assert.throws(() => replaceForcedPreamble(messages, "Old identity", "Soul"), /no preamble/);
});

test("registered command persists selection, refuses missing files, skips no-ops, and completes names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-command-"));
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let command!: { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions: (prefix: string) => { value: string }[] | null };
    const pi = {
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = { cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true, getSystemPromptOptions: () => ({ cwd: dir }), ui: { notify: (text: string) => notices.push(text), setStatus: () => {} } } as unknown as ExtensionContext;
    const project = handlers.get("context_with_system")!;
    const entries = () => session.getBranch().length;

    assert.deepEqual(command.getArgumentCompletions("f")?.map((item) => item.value), ["faye"]);
    assert.deepEqual(command.getArgumentCompletions("")?.map((item) => item.value), ["faye", "clear"]);
    assert.equal(command.getArgumentCompletions("zzz"), null);

    await command.handler("faye", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    const afterSelect = entries();
    await command.handler("faye", ctx);
    assert.equal(entries(), afterSelect);
    assert.match(notices.at(-1)!, /Already faye/);

    await command.handler("missing", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    assert.match(notices.at(-1)!, /No soul "missing". Souls: faye/);
    assert.ok(project({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx));

    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    const afterClear = entries();
    await command.handler("clear", ctx);
    assert.equal(entries(), afterClear);
    assert.match(notices.at(-1)!, /No session soul/);
    assert.equal(project({ messages: [] }, ctx), undefined);

    session.appendCustomEntry(ENTRY_TYPE, { version: 99 });
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Corrupted.*\/soul clear/);
    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("customPrompt keeps settings souls off, leaves the session choice and status truthful", async () => {
  assert.equal(effectiveSoul({ name: "global", source: "default" }, "My prompt"), undefined);
  assert.deepEqual(effectiveSoul({ name: "faye", source: "session" }, "My prompt"), { name: "faye", source: "session" });
  assert.deepEqual(effectiveSoul({ name: "global", source: "default" }, undefined), { name: "global", source: "default" });

  const dir = mkdtempSync(join(tmpdir(), "souls-prompt-"));
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    writeFileSync(join(dir, "global.md"), "Global");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
    const pi = {
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "global" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const options = { cwd: dir, customPrompt: "My prompt" };
    const ctx = {
      cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
      getSystemPromptOptions: () => ({ cwd: dir, customPrompt: options.customPrompt }),
      ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    } as unknown as ExtensionContext;
    const start = handlers.get("before_agent_start")!;
    const project = handlers.get("context_with_system")!;
    const system = (): AgentMessage[] => [{ role: "system", content: "", sections: { preamble: "My prompt" }, timestamp: 0 }];

    start({ systemPromptOptions: { cwd: dir, customPrompt: options.customPrompt } }, ctx);
    assert.equal(project({ messages: system() }, ctx), undefined);
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(custom prompt\)/);
    assert.match(notices.at(-1)!, /Souls: faye, global/);

    await command.handler("faye", ctx);
    const applied = project({ messages: system() }, ctx) as { messages: AgentMessage[] };
    assert.deepEqual(applied.messages[0], { ...system()[0], sections: { preamble: "Faye" } });

    options.customPrompt = "";
    start({ systemPromptOptions: { cwd: dir, customPrompt: options.customPrompt } }, ctx);
    await command.handler("clear", ctx);
    assert.match(notices.at(-1)!, /Soul: global \(default\)/);
    const fallback = project({ messages: system() }, ctx) as { messages: AgentMessage[] };
    assert.equal((fallback.messages[0] as { sections: Record<string, string> }).sections.preamble, "Global");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
