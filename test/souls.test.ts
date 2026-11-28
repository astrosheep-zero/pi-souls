import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type BeforeAgentStartEventResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { applyNakedSoul, applyNoTools, applySoul, replaceForcedPreamble } from "../src/prompt.ts";
import { ENTRY_TYPE, NAKED_ENTRY_TYPE, NOTOOLS_ENTRY_TYPE, effectiveSoul, lastTimeNoteTimestamp, lastUserMessageTimestamp, readConfig, resolveNaked, resolveNoTools, resolveSoul, sessionNaked, sessionNoTools, sessionSoul, loadSoul, listSouls, readSoul, soulFile, soulPerceptionPath, unmatchableModelKeys } from "../src/souls.ts";
import { HOUR_MS, timePerception } from "../src/time.ts";
import { PERCEPTION_MESSAGE_TYPE, worldFor, type Moment } from "../src/perception.ts";

const model = { provider: "provider", id: "model" };
const config = readConfig({ defaultSoul: "global", modelSouls: { "provider/model": "specific" } }, "/tmp");

test("session selection, opt-out and defaults replay from the active branch", () => {
  const session = SessionManager.inMemory();
  const root = session.appendCustomEntry("unrelated", {});
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model)?.name, "specific");
  session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: "manual" });
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model)?.name, "manual");
  const selected = session.getLeafId();
  session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: null, disabled: true });
  assert.equal(sessionSoul(session.getBranch()), null);
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model), undefined);
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), { ...model, id: "other" }), undefined);
  const cleared = session.getLeafId();
  session.appendCustomEntry(ENTRY_TYPE, { version: 1, name: null });
  assert.equal(resolveSoul(config, sessionSoul(session.getBranch()), model)?.name, "specific");
  session.branch(cleared!);
  assert.equal(sessionSoul(session.getBranch()), null);
  session.branch(selected!);
  assert.equal(sessionSoul(session.getBranch()), "manual");
  session.branch(root);
  assert.equal(sessionSoul(session.getBranch()), undefined);
  assert.equal(resolveSoul(config, undefined, { ...model, id: "other" })?.name, "global");
  assert.equal(resolveSoul(readConfig({}, "/tmp"), undefined, model), undefined);
});

test("exact models beat wildcard patterns; otherwise the first matching pattern wins", () => {
  const patterns = readConfig({ defaultSoul: "global", modelSouls: {
    "*/claude-*": "claude",
    "provider/*": "provider",
    "provider/claude-special": "exact",
    "*/gemini-*": "gemini",
    "*/k3*": "kimi",
    "*/kimi-k3*": "kimi",
  } }, "/tmp");
  const select = (provider: string, id: string) => resolveSoul(patterns, undefined, { provider, id })?.name;
  assert.equal(select("provider", "claude-special"), "exact");
  assert.equal(select("provider", "claude-new"), "claude");
  assert.equal(select("provider", "other"), "provider");
  assert.equal(select("new-provider", "gemini-new"), "gemini");
  assert.equal(select("kimi-coding", "k3.1-pro"), "kimi");
  assert.equal(select("opencode-go", "kimi-k3"), "kimi");
  assert.equal(select("openrouter", "anthropic/claude-new"), "claude");
  assert.equal(select("other", "unmatched"), "global");
  assert.equal(resolveSoul(patterns, undefined)?.name, "global");
  assert.equal(resolveSoul(patterns, "manual", model)?.name, "manual");
  assert.equal(resolveSoul(patterns, undefined, model, true), undefined);
});

test("wildcards keep other characters literal and validate only the selected soul", () => {
  const patterns = readConfig({ modelSouls: {
    "*/k3.1-*": "kimi",
    "*/broken-*": "../unsafe",
    "provider/broken-exact": "exact",
    "*": "not-a-provider-model-key",
  } }, "/tmp");
  assert.equal(resolveSoul(patterns, undefined, { ...model, id: "k3.1-pro" })?.name, "kimi");
  for (const id of ["k3x1-pro", "prefix-k3.1-pro", "other"]) {
    assert.equal(resolveSoul(patterns, undefined, { ...model, id }), undefined);
  }
  assert.equal(resolveSoul(patterns, undefined, { ...model, id: "broken-exact" })?.name, "exact");
  assert.throws(() => resolveSoul(patterns, undefined, { ...model, id: "broken-new" }), /modelSouls\["\*\/broken-\*"\]/);
  assert.deepEqual(unmatchableModelKeys(patterns), ["*"]);
});

test("soulless via CLI or env skips defaults; selection wins and clear/reset remain soulless", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-less-"));
  const previous = process.env.SOULLESS;
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    let flag = false;
    let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
    const registeredFlags = new Map<string, string>();
    const pi = {
      registerFlag: (name: string, options: { type: string }) => {
        registeredFlags.set(name, options.type);
      },
      getFlag: (name: string) => name === "soulless" && flag,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI;
    extension(pi);
    assert.equal(registeredFlags.get("soulless"), "boolean");
    assert.equal(registeredFlags.get("naked"), "boolean");
    const ctx = {
      cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
      getSystemPromptOptions: () => ({ cwd: dir }),
      ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    };
    const request = () => handlers.get("context_with_system")![0]({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx) as { messages: AgentMessage[] } | undefined;

    process.env.SOULLESS = "0";
    assert.ok(request());
    process.env.SOULLESS = "1";
    assert.equal(request(), undefined);
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless\)/);

    process.env.SOULLESS = "0";
    flag = true;
    assert.equal(request(), undefined); // CLI still wins over SOULLESS=0.
    await command.handler("@faye", ctx);
    const applied = request()!;
    const head = applied.messages[0];
    assert.ok(head.role === "system");
    assert.equal(head.sections?.preamble, "Faye");
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: faye \(session\)/);
    await command.handler("clear", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless\)/);
    assert.equal(request(), undefined);
    assert.equal(sessionSoul(session.getBranch()), null);
    await command.handler("reset", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless\)/);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    assert.equal(request(), undefined);
    // Suppressed defaults need not even contain a valid name.
    assert.equal(resolveSoul(readConfig({ defaultSoul: 42 }, dir), undefined, model, true), undefined);
    assert.equal(resolveSoul(readConfig({ defaultSoul: 42 }, dir), null, model), undefined);
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

test("directory souls are listed, render from their own folder, and win over a same-named file", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-dir-"));
  try {
    writeFileSync(join(dir, "flat.md"), "Flat");
    mkdirSync(join(dir, "deep", "parts"), { recursive: true });
    writeFileSync(join(dir, "deep", "SOUL.md"), "---\nicon: 🦈\n---\nDeep {{ cwd }}\n{% include 'parts/own' %}\n{% render 'parts/shared' %}");
    writeFileSync(join(dir, "deep", "parts", "own.md"), "own-part");
    mkdirSync(join(dir, "parts"), { recursive: true });
    writeFileSync(join(dir, "parts", "shared.md"), "shared-part");
    mkdirSync(join(dir, "empty"));
    mkdirSync(join(dir, "both"));
    writeFileSync(join(dir, "both", "SOUL.md"), "Nested wins");
    writeFileSync(join(dir, "both.md"), "Flat loses");

    // A directory only counts with SOUL.md inside it; the nested form wins over the file.
    assert.deepEqual(listSouls(dir), ["both", "deep", "flat"]);
    assert.equal(readSoul(dir, "both").body, "Nested wins");
    assert.deepEqual(readSoul(dir, "deep", { model: { provider: "p", id: "m" }, cwd: "/work" }), {
      body: "Deep /work\nown-part\nshared-part",
      icon: "🦈",
    });
    assert.equal(loadSoul(dir, "deep", { model: { provider: "", id: "" }, cwd: "/here" }).includes("Deep /here"), true);
    assert.equal(soulFile(dir, "deep").path, join(dir, "deep", "SOUL.md"));
    assert.deepEqual(soulFile(dir, "deep").root, [join(dir, "deep"), dir]);
    assert.deepEqual(soulFile(dir, "flat").root, [dir]);
    assert.throws(() => loadSoul(dir, "empty"), /Soul "empty" not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a directory soul's perception is found by extension precedence and unsafe names never resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-perception-"));
  try {
    mkdirSync(join(dir, "faye"));
    writeFileSync(join(dir, "faye", "SOUL.md"), "Faye");
    assert.equal(soulPerceptionPath(dir, "faye"), undefined);

    writeFileSync(join(dir, "faye", "perception.js"), "export const perception = () => [];");
    assert.equal(soulPerceptionPath(dir, "faye"), join(dir, "faye", "perception.js"));
    writeFileSync(join(dir, "faye", "perception.mjs"), "export const perception = () => [];");
    assert.equal(soulPerceptionPath(dir, "faye"), join(dir, "faye", "perception.mjs"));
    writeFileSync(join(dir, "faye", "perception.ts"), "export const perception = () => [];");
    assert.equal(soulPerceptionPath(dir, "faye"), join(dir, "faye", "perception.ts"));

    writeFileSync(join(dir, "flat.md"), "Flat");
    assert.equal(soulPerceptionPath(dir, "flat"), undefined);
    assert.equal(soulPerceptionPath(dir, "../escape"), undefined);
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
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const pi = {
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: () => {},
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const notices: string[] = [];
    const ctx = { cwd: dir, model, sessionManager: session, hasUI: true, ui: { notify: (text: string, type: string) => notices.push(`${type}: ${text}`), setStatus: () => {} } };
    const request = () => handlers.get("context_with_system")![0]({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx);
    const options: Record<string, unknown> = { cwd: dir };
    handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);

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

    handlers.get("agent_settled")![0]({ aborted: false }, ctx);
    assert.ok(request()); // A stale force does not apply after the run.
    ctx.hasUI = false;
    handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);
    assert.throws(request, /replacement failed/);
    assert.equal(request(), undefined);

    // Print mode warnings go to stderr, but a compatible force must not throw.
    const warn = console.warn;
    const warnings: string[] = [];
    try {
      console.warn = (text: string) => warnings.push(text);
      handlers.get("session_start")![0]({}, ctx);
      handlers.get("before_agent_start")![0]({ messageType: "custom", systemPromptOptions: options }, ctx);
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

test("registered command persists selection, refuses missing files, skips no-ops, and completes @names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-command-"));
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    writeFileSync(join(dir, "clear.md"), "Literal clear");
    writeFileSync(join(dir, "reload.md"), "Literal reload");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    let command!: { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions: (prefix: string) => { value: string }[] | null };
    const pi = {
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = { cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true, getSystemPromptOptions: () => ({ cwd: dir }), ui: { notify: (text: string) => notices.push(text), setStatus: () => {} } } as unknown as ExtensionContext;
    const project = handlers.get("context_with_system")![0];
    const entries = () => session.getBranch().length;

    assert.deepEqual(command.getArgumentCompletions("f"), null); // Bare names cannot switch.
    assert.deepEqual(command.getArgumentCompletions("@")?.map((item) => item.value), ["@clear", "@faye", "@reload"]);
    assert.deepEqual(command.getArgumentCompletions("@c")?.map((item) => item.value), ["@clear"]);
    assert.deepEqual(command.getArgumentCompletions("")?.map((item) => item.value), ["@clear", "@faye", "@reload", "naked", "clear", "reset", "reload"]);
    assert.deepEqual(command.getArgumentCompletions("n")?.map((item) => item.value), ["naked"]);
    assert.deepEqual(command.getArgumentCompletions("naked ")?.map((item) => item.value), ["naked on", "naked off"]);
    assert.deepEqual(command.getArgumentCompletions("r")?.map((item) => item.value), ["reset", "reload"]);
    assert.equal(command.getArgumentCompletions("zzz"), null);

    for (const input of ["faye", "@ faye"]) {
      await command.handler(input, ctx);
      assert.equal(sessionSoul(session.getBranch()), undefined);
      assert.match(notices.at(-1)!, /Usage: \/soul \[@<name>\|naked\|clear\|reset\|reload\]/);
    }
    assert.equal(entries(), 0);
    await command.handler("@faye", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    const afterSelect = entries();
    await command.handler("@faye", ctx);
    assert.equal(entries(), afterSelect);
    assert.match(notices.at(-1)!, /Already faye/);

    await command.handler("@missing", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    assert.match(notices.at(-1)!, /No soul "missing". Souls: @clear, @faye, @reload/);
    assert.ok(project({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx));

    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), null);
    const afterClear = entries();
    await command.handler("clear", ctx);
    assert.equal(entries(), afterClear);
    assert.match(notices.at(-1)!, /Already soulless/);
    assert.equal(project({ messages: [] }, ctx), undefined);
    await command.handler("reset", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    const afterReset = entries();
    await command.handler("reset", ctx);
    assert.equal(entries(), afterReset);
    assert.match(notices.at(-1)!, /Already following defaults/);

    await command.handler("@clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), "clear");
    const literalClear = entries();
    await command.handler("reload", ctx);
    assert.equal(entries(), literalClear);
    assert.equal(sessionSoul(session.getBranch()), "clear");
    assert.match(notices.at(-1)!, /Reloaded clear/);
    await command.handler("@reload", ctx);
    assert.equal(sessionSoul(session.getBranch()), "reload");
    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), null);

    session.appendCustomEntry(ENTRY_TYPE, { version: 99 });
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Corrupted.*\/soul clear/);
    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), null);
    session.appendCustomEntry(ENTRY_TYPE, { version: 99 });
    await command.handler("reset", ctx);
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
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
    const pi = {
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "global" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const options = { cwd: dir, customPrompt: "My prompt" };
    const ctx = {
      cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
      getSystemPromptOptions: () => ({ cwd: dir, customPrompt: options.customPrompt }),
      ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    } as unknown as ExtensionContext;
    const start = handlers.get("before_agent_start")![0];
    const project = handlers.get("context_with_system")![0];
    const system = (): AgentMessage[] => [{ role: "system", content: "", sections: { preamble: "My prompt" }, timestamp: 0 }];

    start({ systemPromptOptions: { cwd: dir, customPrompt: options.customPrompt } }, ctx);
    assert.equal(project({ messages: system() }, ctx), undefined);
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(custom prompt\)/);
    assert.match(notices.at(-1)!, /Souls: @faye, @global/);

    await command.handler("@faye", ctx);
    const applied = project({ messages: system() }, ctx) as { messages: AgentMessage[] };
    assert.deepEqual(applied.messages[0], { ...system()[0], sections: { preamble: "Faye" } });

    options.customPrompt = "";
    start({ systemPromptOptions: { cwd: dir, customPrompt: options.customPrompt } }, ctx);
    await command.handler("clear", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless\)/);
    assert.equal(project({ messages: system() }, ctx), undefined);
    await command.handler("reset", ctx);
    assert.match(notices.at(-1)!, /Soul: global \(default\)/);
    const fallback = project({ messages: system() }, ctx) as { messages: AgentMessage[] };
    assert.equal((fallback.messages[0] as { sections: Record<string, string> }).sections.preamble, "Global");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("builtin time perception returns reminders only for due human moments", async () => {
  const t0 = new Date(2026, 9, 27, 2, 14, 0).getTime();
  const human: Moment = { kind: "human", text: "hi" };
  const say = (now: number, lastNoteAt?: number, absenceMs?: number, moment: Moment = human) =>
    timePerception(lastNoteAt)(moment, { ...worldFor({ now, sessionId: "s", cwd: "/", soul: "faye" }), absenceMs });
  assert.deepEqual(await say(t0), [{ kind: "reminder", text: "⌚ 02:14 · Tue, Oct 27, 2026" }]);
  assert.deepEqual(await say(t0 + HOUR_MS - 1, t0, 3 * HOUR_MS), []);
  assert.deepEqual(await say(t0 + HOUR_MS, t0, 20 * 60_000), [{ kind: "reminder", text: "⌚ 03:14 · Tue, Oct 27, 2026" }]);
  for (const [absenceMs, elapsed] of [[HOUR_MS, "1h"], [6 * HOUR_MS + 20 * 60_000, "6h 20m"], [74 * HOUR_MS, "3d 2h"]] as const) {
    assert.deepEqual(await say(t0, undefined, absenceMs), [{ kind: "reminder", text: `⌚ 02:14 · Tue, Oct 27, 2026\n(${elapsed} since *human* was last present)` }]);
  }
  assert.deepEqual(await say(t0, undefined, undefined, { kind: "wake", source: "resume" }), []);
  assert.deepEqual(await say(t0, undefined, undefined, { kind: "tool", phase: "before", category: "reading", toolName: "read" }), []);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(await say(invalid), []);
    assert.deepEqual(await say(t0, invalid, invalid), [{ kind: "reminder", text: "⌚ 02:14 · Tue, Oct 27, 2026" }]);
  }
  assert.deepEqual(await say(t0, t0 + HOUR_MS), []);
});

test("time note replay ignores directory perceptions and follows branch entries", () => {
  const session = SessionManager.inMemory();
  const root = session.appendCustomEntry("root", {});
  session.appendCustomMessageEntry(PERCEPTION_MESSAGE_TYPE, "directory", true, { moment: "human" });
  assert.equal(lastTimeNoteTimestamp(session.getBranch()), undefined);
  session.appendCustomMessageEntry(PERCEPTION_MESSAGE_TYPE, "clock", true, { moment: "human", timestamp: 200 });
  session.appendCustomMessageEntry(PERCEPTION_MESSAGE_TYPE, "directory", true, { moment: "tool" });
  session.appendCustomMessageEntry(PERCEPTION_MESSAGE_TYPE, "bad timestamp", true, { timestamp: Infinity });
  assert.equal(lastTimeNoteTimestamp(session.getBranch()), 200);
  session.branch(root);
  assert.equal(lastTimeNoteTimestamp(session.getBranch()), undefined);
});

test("Pi time awareness sends visible perceptions, throttles hourly and follows branch rewinds", async () => {
  const t0 = new Date(2026, 9, 27, 2, 14, 0).getTime();
  const dir = mkdtempSync(join(tmpdir(), "souls-time-"));
  const realNow = Date.now;
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    const session = SessionManager.inMemory();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let soullessFlag = false;
    let timeaware: boolean | undefined;
    const pi = {
      registerFlag: () => {}, getFlag: (name: string) => name === "soulless" && soullessFlag,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye", timeaware }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      sendMessage: () => assert.fail("a human perception must not enqueue an independent message"),
      registerEntryRenderer: () => {}, registerCommand: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = { cwd: dir, model, sessionManager: session, hasUI: true, ui: { notify: () => {}, setStatus: () => {} } };
    const start = async (extra: Record<string, unknown> = {}) => {
      const result = await handlers.get("before_agent_start")!({ messageType: "user", prompt: "hi", systemPromptOptions: { cwd: dir }, ...extra }, ctx) as BeforeAgentStartEventResult | undefined;
      const message = result?.message;
      if (message) session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      return message;
    };
    let now = t0;
    Date.now = () => now;
    timeaware = false;
    assert.equal(await start(), undefined);
    timeaware = undefined;
    const first = await start();
    assert.deepEqual(first, { customType: PERCEPTION_MESSAGE_TYPE, display: true, details: { kinds: ["reminder"], moment: "human", timestamp: t0 }, content: [{ type: "text", text: "⌚ 02:14 · Tue, Oct 27, 2026" }] });
    const firstNoteId = session.getLeafId()!;
    assert.equal(await start({ messageType: "custom" }), undefined);
    session.appendMessage({ role: "user", content: "hi", timestamp: t0 });
    assert.equal(lastUserMessageTimestamp(session.getBranch()), t0);
    now = t0 + 30 * 60_000;
    assert.equal(await start(), undefined);
    session.appendMessage({ role: "user", content: "still here", timestamp: now });
    // A recent non-time perception must not delay the hourly clock refresh.
    session.appendCustomMessageEntry(PERCEPTION_MESSAGE_TYPE, "directory", false, { moment: "human" });
    now = t0 + 80 * 60_000;
    assert.deepEqual((await start())?.content, [{ type: "text", text: "⌚ 03:34 · Tue, Oct 27, 2026" }]);
    session.appendMessage({ role: "user", content: "back later", timestamp: now });
    now += 2 * HOUR_MS;
    assert.deepEqual((await start())?.content, [{ type: "text", text: "⌚ 05:34 · Tue, Oct 27, 2026\n(2h since *human* was last present)" }]);
    assert.equal(await start(), undefined);
    session.branch(firstNoteId);
    assert.equal(lastTimeNoteTimestamp(session.getBranch()), t0);
    assert.ok(await start()); // The later branch's note cannot suppress this branch.
    soullessFlag = true;
    assert.equal(await start(), undefined);
    soullessFlag = false;
    assert.equal(await start({ systemPromptOptions: { cwd: dir, customPrompt: "Override" } }), undefined);
    now += HOUR_MS;
    writeFileSync(join(dir, "faye.md"), " ");
    assert.equal(await start(), undefined);
    rmSync(join(dir, "faye.md"));
    assert.equal(await start(), undefined);
  } finally {
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("naked projection leaves only the soul body and preserves tool declarations across system deltas", () => {
  const toolA = { name: "read", description: "read", parameters: { type: "object", properties: {} } } as any;
  const toolB = { name: "bash", description: "bash", parameters: { type: "object", properties: {} } } as any;
  const messages: AgentMessage[] = [
    { role: "system", content: "extra", sections: { preamble: "Pi", tools: "t", rules: "r", docs: "d", cwd: "/tmp", notesoup_protocol: "n" }, toolsAdded: [toolA], timestamp: 10 },
    { role: "user", content: "hi", timestamp: 11 },
    { role: "system", content: "more", sections: { rules: "r2", cwd: "/other" }, timestamp: 12 },
    { role: "system", content: "", sections: { notesoup_tools: "x" }, toolsAdded: [toolB], toolsRemoved: [{ name: "read" }], timestamp: 13 },
  ];
  const original = structuredClone(messages);
  const projected = applyNakedSoul(messages, "Faye only");
  assert.deepEqual(messages, original);
  assert.equal(getCurrentSystemPrompt(projected as any), "Faye only");
  assert.deepEqual(getCurrentTools(projected as any).map((tool) => tool.name), ["bash"]);
  // Section-only later system message is dropped; tool-bearing later system message stays anchored with empty text.
  assert.equal(projected.length, 3);
  assert.equal(projected[1], messages[1]);
  assert.deepEqual(projected[0], { role: "system", content: "Faye only", toolsAdded: [toolA], timestamp: 10 });
  assert.deepEqual(projected[2], { role: "system", content: "", toolsAdded: [toolB], toolsRemoved: [{ name: "read" }], timestamp: 13 });

  // Plain system message without sections and transcripts without a system message both produce soul-only prompts.
  const plain = applyNakedSoul([{ role: "system", content: "Plain", timestamp: 5 }, { role: "user", content: "yo", timestamp: 6 }], "Faye");
  assert.equal(getCurrentSystemPrompt(plain as any), "Faye");
  const headless = applyNakedSoul([{ role: "user", content: "yo", timestamp: 6 }], "Faye");
  assert.equal(getCurrentSystemPrompt(headless as any), "Faye");
});

test("naked mode follows --naked and /soul naked overrides on the active branch, including reset, footer, and forced prompts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-naked-"));
  try {
    writeFileSync(join(dir, "faye.md"), "---\nicon: 🦈\n---\nFaye body");
    writeFileSync(join(dir, "naked.md"), "Literal naked soul");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const statuses: (string | undefined)[] = [];
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    let nakedFlag = false;
    let soullessFlag = false;
    let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
    const pi = {
      registerFlag: () => {},
      getFlag: (name: string) => name === "naked" ? nakedFlag : name === "soulless" ? soullessFlag : false,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = {
      cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
      getSystemPromptOptions: () => ({ cwd: dir }),
      ui: {
        notify: (text: string) => notices.push(text),
        setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      },
    } as unknown as ExtensionContext;
    const system = (): AgentMessage[] => [{
      role: "system", content: "", sections: { preamble: "Pi", tools: "<tools>", rules: "<rules>", cwd: dir }, timestamp: 0,
    }];
    const request = () => handlers.get("context_with_system")![0]({ messages: system() }, ctx) as { messages: AgentMessage[] } | undefined;

    // Default: non-naked replaces only preamble.
    const normal = request()!;
    assert.ok(normal.messages[0].role === "system");
    assert.equal(normal.messages[0].sections?.preamble, "Faye body");
    assert.equal(normal.messages[0].sections?.rules, "<rules>");
    assert.equal(statuses.at(-1), "🦈");

    // CLI --naked strips everything down to soul body.
    nakedFlag = true;
    const fromFlag = request()!;
    assert.equal(getCurrentSystemPrompt(fromFlag.messages as any), "Faye body");
    assert.equal(statuses.at(-1), "🦈 (naked)");

    // /soul naked toggles off for the session, overriding --naked.
    const beforeToggle = session.getLeafId();
    await command.handler("naked", ctx);
    assert.equal(sessionNaked(session.getBranch()), false);
    assert.equal(resolveNaked(sessionNaked(session.getBranch()), nakedFlag), false);
    assert.match(notices.at(-1)!, /Naked: off/);
    assert.equal(statuses.at(-1), "🦈");
    const toggledOff = request()!;
    assert.ok(toggledOff.messages[0].role === "system" && toggledOff.messages[0].sections?.rules === "<rules>");

    // Explicit naked off is a no-op when already off; naked on enables it.
    const countAfterOff = session.getBranch().length;
    await command.handler("naked off", ctx);
    assert.equal(session.getBranch().length, countAfterOff);
    assert.match(notices.at(-1)!, /Already not naked/);

    await command.handler("naked on", ctx);
    assert.equal(sessionNaked(session.getBranch()), true);
    assert.equal(statuses.at(-1), "🦈 (naked)");
    assert.equal(getCurrentSystemPrompt(request()!.messages as any), "Faye body");

    // Literal soul named @naked still selects the soul, independent of naked mode.
    await command.handler("@naked", ctx);
    assert.equal(getCurrentSystemPrompt(request()!.messages as any), "Literal naked soul");
    assert.equal(statuses.at(-1), "naked (naked)");
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: naked \(session, naked\)/);

    // Forced prompt in naked mode becomes only the soul body, and restores on failure.
    const options: Record<string, unknown> = { cwd: dir, forceSystemPrompt: "Pi\n\nForced addendum" };
    handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);
    assert.ok(request());
    assert.equal(options.forceSystemPrompt, "Literal naked soul");
    assert.equal(notices.at(-1), "Soul: naked prompt");
    rmSync(join(dir, "naked.md"));
    assert.equal(request(), undefined);
    assert.equal(options.forceSystemPrompt, "Pi\n\nForced addendum");
    handlers.get("agent_settled")![0]({ aborted: false }, ctx);

    // /soul reset restores both soul selection and naked override back to CLI defaults (--naked = true).
    await command.handler("reset", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    assert.equal(sessionNaked(session.getBranch()), undefined);
    assert.equal(resolveNaked(sessionNaked(session.getBranch()), nakedFlag), true);
    assert.equal(getCurrentSystemPrompt(request()!.messages as any), "Faye body");

    // When no soul is active (soulless), naked mode leaves Pi's prompt untouched.
    soullessFlag = true;
    assert.equal(request(), undefined);
    soullessFlag = false;

    // Corrupted naked entry is repaired by /soul reset and follows branch navigation.
    if (beforeToggle) {
      session.branch(beforeToggle);
      assert.equal(sessionNaked(session.getBranch()), undefined);
    }
    session.appendCustomEntry(NAKED_ENTRY_TYPE, { version: 99 });
    assert.throws(() => sessionNaked(session.getBranch()), /Corrupted naked entry/);
    nakedFlag = false;
    await command.handler("reset", ctx);
    assert.equal(sessionNaked(session.getBranch()), undefined);
    assert.equal(resolveNaked(sessionNaked(session.getBranch()), nakedFlag), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notools projection strips every tool declaration, skills and tool deltas without touching history", () => {
  const toolA = { name: "read", description: "read", parameters: { type: "object", properties: {} } } as any;
  const toolB = { name: "bash", description: "bash", parameters: { type: "object", properties: {} } } as any;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const messages: AgentMessage[] = [
    { role: "system", content: "extra", sections: { preamble: "Pi", tools: "<tools>read</tools>", rules: "r", skills: "s", cwd: "/tmp" }, toolsAdded: [toolA], timestamp: 10 },
    { role: "user", content: "hi", timestamp: 11 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], api: "test", provider: "test", model: "test", stopReason: "toolUse", usage, timestamp: 12 },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 13 },
    { role: "system", content: "more", sections: { rules: "r2" }, timestamp: 14 },
    { role: "system", content: "", sections: { skills: "x" }, toolsAdded: [toolB], toolsRemoved: [{ name: "read" }], timestamp: 15 },
  ];
  const original = structuredClone(messages);
  const projected = applyNoTools(messages);
  assert.deepEqual(messages, original);
  // Prior tool calls and results never block the strip.
  assert.deepEqual(getCurrentTools(projected as any), []);
  const prompt = getCurrentSystemPrompt(projected as any);
  assert.ok(prompt.includes("<tools>\n(none)\n</tools>"));
  assert.ok(!prompt.includes("<tools>read</tools>"));
  assert.ok(!prompt.includes("<skills>"));
  assert.equal(projected.length, 5);
  assert.equal(projected[1], messages[1]);
  assert.equal(projected[2], messages[2]);
  assert.equal(projected[3], messages[3]);
  const head = projected[0];
  assert.ok(head.role === "system");
  assert.equal(head.content, "extra");
  assert.deepEqual(head.sections, { preamble: "Pi", tools: "<tools>\n(none)\n</tools>", rules: "r", cwd: "/tmp" });
  assert.equal(head.toolsAdded, undefined);
  assert.deepEqual(projected[4], { role: "system", content: "more", sections: { rules: "r2" }, timestamp: 14 });

  const headless = applyNoTools([{ role: "user", content: "yo", timestamp: 6 }]);
  assert.deepEqual(headless, [{ role: "user", content: "yo", timestamp: 6 }]);
});

test("notools command toggles a session strip that survives /soul reset, soulless mode and naked mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-notools-"));
  try {
    writeFileSync(join(dir, "faye.md"), "---\nicon: 🦈\n---\nFaye body");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const statuses: (string | undefined)[] = [];
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    let nakedFlag = false;
    let soullessFlag = false;
    type Command = { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions: (prefix: string) => { value: string }[] | null; description: string };
    const commands = new Map<string, Command>();
    const pi = {
      registerFlag: () => {},
      getFlag: (name: string) => name === "naked" ? nakedFlag : name === "soulless" ? soullessFlag : false,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye" }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (name: string, registered: Command) => { commands.set(name, registered); },
      registerEntryRenderer: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const notools = commands.get("notools")!;
    const soul = commands.get("soul")!;
    assert.equal(notools.description, "Toggle tool declarations: /notools [on|off]");
    assert.deepEqual(notools.getArgumentCompletions("")?.map((item) => item.value), ["on", "off"]);
    assert.deepEqual(notools.getArgumentCompletions("o")?.map((item) => item.value), ["on", "off"]);
    assert.equal(notools.getArgumentCompletions("x"), null);
    const ctx = {
      cwd: dir, model, sessionManager: session, isIdle: () => true, hasUI: true,
      getSystemPromptOptions: () => ({ cwd: dir }),
      ui: {
        notify: (text: string) => notices.push(text),
        setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      },
    } as unknown as ExtensionContext;
    const tool = { name: "read", description: "read", parameters: { type: "object", properties: {} } } as any;
    const system = (): AgentMessage[] => [{
      role: "system", content: "base", sections: { preamble: "Pi", tools: "<tools>read</tools>", rules: "<rules>", skills: "<skills>" }, toolsAdded: [tool], timestamp: 0,
    }];
    const request = () => handlers.get("context_with_system")![0]({ messages: system() }, ctx) as { messages: AgentMessage[] } | undefined;

    handlers.get("before_agent_start")![0]({ systemPromptOptions: { cwd: dir } }, ctx);
    assert.equal(getCurrentTools(request()!.messages as any).length, 1);
    assert.equal(statuses.at(-1), "🦈");

    await notools.handler("on", ctx);
    assert.equal(sessionNoTools(session.getBranch()), true);
    assert.equal(resolveNoTools(sessionNoTools(session.getBranch())), true);
    assert.equal(statuses.at(-1), "🦈 (notools)");
    const stripped = request()!;
    assert.deepEqual(getCurrentTools(stripped.messages as any), []);
    const head = stripped.messages[0];
    assert.ok(head.role === "system");
    assert.equal(head.content, "base");
    assert.equal(head.sections?.tools, "<tools>\n(none)\n</tools>");
    assert.equal(head.sections?.skills, undefined);
    assert.equal(head.sections?.rules, "<rules>");
    assert.equal(head.sections?.preamble, "Faye body");
    assert.equal(head.toolsAdded, undefined);
    assert.ok(getCurrentSystemPrompt(stripped.messages as any).includes("<tools>\n(none)\n</tools>"));

    const afterOn = session.getBranch().length;
    await notools.handler("on", ctx);
    assert.equal(session.getBranch().length, afterOn);
    assert.match(notices.at(-1)!, /No tools: already on/);

    await notools.handler("off", ctx);
    assert.equal(sessionNoTools(session.getBranch()), false);
    assert.equal(statuses.at(-1), "🦈");
    assert.equal(getCurrentTools(request()!.messages as any).length, 1);

    await notools.handler("", ctx);
    assert.match(notices.at(-1)!, /No tools: on/);
    const onLeaf = session.getLeafId()!;
    await notools.handler("off", ctx);
    assert.equal(sessionNoTools(session.getBranch()), false);
    session.branch(onLeaf);
    assert.equal(sessionNoTools(session.getBranch()), true);

    const beforeInvalid = session.getBranch().length;
    await notools.handler("maybe", ctx);
    assert.match(notices.at(-1)!, /Usage: \/notools \[on\|off\]/);
    assert.equal(session.getBranch().length, beforeInvalid);

    // Corrupted entries fail closed, and /notools off repairs them.
    session.appendCustomEntry(NOTOOLS_ENTRY_TYPE, { version: 99 });
    assert.throws(() => sessionNoTools(session.getBranch()), /Corrupted notools entry/);
    assert.equal(request(), undefined);
    await notools.handler("off", ctx);
    assert.equal(sessionNoTools(session.getBranch()), false);
    assert.equal(getCurrentTools(request()!.messages as any).length, 1);

    // Orthogonal to /soul: /soul reset clears soul and naked state, never notools.
    await notools.handler("on", ctx);
    await soul.handler("@faye", ctx);
    await soul.handler("reset", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    assert.equal(sessionNaked(session.getBranch()), undefined);
    assert.equal(sessionNoTools(session.getBranch()), true);
    assert.equal(statuses.at(-1), "🦈 (notools)");

    // With no active soul the strip still applies and the footer says so.
    soullessFlag = true;
    assert.deepEqual(getCurrentTools(request()!.messages as any), []);
    assert.equal(statuses.at(-1), "notools");
    await soul.handler("", ctx);
    assert.match(notices.at(-1)!, /Soul: none \(soulless, notools\)/);
    soullessFlag = false;

    // Combined with naked mode: only the soul body remains, tools are still stripped.
    nakedFlag = true;
    const options: Record<string, unknown> = { cwd: dir, forceSystemPrompt: "Pi\n\nForced addendum" };
    handlers.get("before_agent_start")![0]({ systemPromptOptions: options }, ctx);
    const nakedStripped = request()!;
    assert.equal(statuses.at(-1), "🦈 (naked, notools)");
    assert.equal(getCurrentSystemPrompt(nakedStripped.messages as any), "Faye body");
    assert.deepEqual(getCurrentTools(nakedStripped.messages as any), []);
    assert.equal(options.forceSystemPrompt, "Faye body");
    handlers.get("agent_settled")![0]({ aborted: false }, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
