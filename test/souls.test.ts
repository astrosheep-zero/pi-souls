import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { applySoul } from "../src/prompt.ts";
import { ENTRY_TYPE, readConfig, resolveSoul, sessionSoul, loadSoul, listSouls, unmatchableModelKeys } from "../src/souls.ts";

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
  assert.throws(() => applySoul([{ role: "system", content: "opaque", timestamp: 0 }], "Faye"), /structured/);
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
      getSettings: () => ({ soulsDir: dir }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = { cwd: dir, model, sessionManager: session, isIdle: () => true, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
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
    assert.match(notices.at(-1)!, /Already using faye/);

    await command.handler("missing", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    assert.match(notices.at(-1)!, /No soul named "missing".*Available: faye/);
    assert.ok(project({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx));

    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    const afterClear = entries();
    await command.handler("clear", ctx);
    assert.equal(entries(), afterClear);
    assert.match(notices.at(-1)!, /No session soul to clear/);
    assert.equal(project({ messages: [] }, ctx), undefined);

    session.appendCustomEntry(ENTRY_TYPE, { version: 99 });
    await command.handler("", ctx);
    assert.match(notices.at(-1)!, /corrupted.*\/soul clear/);
    await command.handler("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
