import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { applySoul, replaceForcedPreamble } from "../src/prompt.ts";
import { ENTRY_TYPE, effectiveSoul, lastTimeNoteTimestamp, lastUserMessageTimestamp, readConfig, resolveSoul, sessionSoul, loadSoul, listSouls, readSoul, soulFile, soulPerceptionPath, unmatchableModelKeys } from "../src/souls.ts";
import { HOUR_MS, timePerception } from "../src/time.ts";
import { PERCEPTION_MESSAGE_TYPE, worldFor, wrapReminder, type Moment } from "../src/perception.ts";

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
    const pi = {
      registerFlag: (name: string, options: { type: string }) => {
        assert.equal(name, "soulless"); assert.equal(options.type, "boolean");
      },
      getFlag: () => flag,
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

    writeFileSync(join(dir, "faye", "perception.js"), "export const perception = () => undefined;");
    assert.equal(soulPerceptionPath(dir, "faye"), join(dir, "faye", "perception.js"));
    writeFileSync(join(dir, "faye", "perception.mjs"), "export const perception = () => undefined;");
    assert.equal(soulPerceptionPath(dir, "faye"), join(dir, "faye", "perception.mjs"));
    writeFileSync(join(dir, "faye", "perception.ts"), "export const perception = () => undefined;");
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
    assert.deepEqual(command.getArgumentCompletions("")?.map((item) => item.value), ["@clear", "@faye", "@reload", "clear", "reset", "reload"]);
    assert.deepEqual(command.getArgumentCompletions("r")?.map((item) => item.value), ["reset", "reload"]);
    assert.equal(command.getArgumentCompletions("zzz"), null);

    for (const input of ["faye", "@ faye"]) {
      await command.handler(input, ctx);
      assert.equal(sessionSoul(session.getBranch()), undefined);
      assert.match(notices.at(-1)!, /Usage: \/soul \[@<name>\|clear\|reset\|reload\]/);
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

test("builtin time perception returns bare text only for due human moments", async () => {
  const t0 = new Date(2026, 9, 27, 2, 14, 0).getTime();
  const human: Moment = { kind: "human", text: "hi" };
  const say = (now: number, lastNoteAt?: number, absenceMs?: number, moment: Moment = human) =>
    timePerception(lastNoteAt)(moment, { ...worldFor({ now, sessionId: "s", cwd: "/", soul: "faye" }), absenceMs });
  assert.deepEqual(await say(t0), { text: "⌚ 02:14 · Tue, Oct 27" });
  assert.equal(await say(t0 + HOUR_MS - 1, t0, 3 * HOUR_MS), undefined);
  assert.deepEqual(await say(t0 + HOUR_MS, t0, 20 * 60_000), { text: "⌚ 03:14 · Tue, Oct 27" });
  for (const [absenceMs, elapsed] of [[HOUR_MS, "1h"], [6 * HOUR_MS + 20 * 60_000, "6h 20m"], [74 * HOUR_MS, "3d 2h"]] as const) {
    assert.deepEqual(await say(t0, undefined, absenceMs), { text: `⌚ 02:14 · Tue, Oct 27\n(${elapsed} since *human* was last present)` });
  }
  assert.equal(await say(t0, undefined, undefined, { kind: "wake", source: "resume" }), undefined);
  assert.equal(await say(t0, undefined, undefined, { kind: "tool", phase: "before", category: "reading", toolName: "read" }), undefined);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(await say(invalid), undefined);
    assert.deepEqual(await say(t0, invalid, invalid), { text: "⌚ 02:14 · Tue, Oct 27" });
  }
  assert.equal(await say(t0, t0 + HOUR_MS), undefined);
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
    const sent: { customType: string; content: string; display: boolean; details: { moment: string; timestamp: number } }[] = [];
    let soullessFlag = false;
    let timeaware: boolean | undefined;
    const pi = {
      registerFlag: () => {}, getFlag: () => soullessFlag,
      getSettings: () => ({ soulsDir: dir, defaultSoul: "faye", timeaware }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      sendMessage: (message: typeof sent[number]) => {
        sent.push(message);
        session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      },
      registerEntryRenderer: () => {}, registerCommand: () => {},
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = { cwd: dir, model, sessionManager: session, hasUI: true, ui: { notify: () => {}, setStatus: () => {} } };
    const start = async (extra: Record<string, unknown> = {}) => {
      const count = sent.length;
      assert.equal(handlers.get("before_agent_start")!({ messageType: "user", prompt: "hi", systemPromptOptions: { cwd: dir }, ...extra }, ctx), undefined);
      await Promise.resolve();
      return sent.length > count ? sent.at(-1) : undefined;
    };
    let now = t0;
    Date.now = () => now;
    timeaware = false;
    assert.equal(await start(), undefined);
    timeaware = undefined;
    const first = await start();
    assert.deepEqual(first, { customType: PERCEPTION_MESSAGE_TYPE, display: true, details: { moment: "human", timestamp: t0 }, content: wrapReminder("⌚ 02:14 · Tue, Oct 27") });
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
    assert.equal((await start())?.content, wrapReminder("⌚ 03:34 · Tue, Oct 27"));
    session.appendMessage({ role: "user", content: "back later", timestamp: now });
    now += 2 * HOUR_MS;
    assert.match((await start())!.content, /\(2h since \*human\* was last present\)/);
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
