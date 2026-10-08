import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { applySoul } from "../src/prompt.ts";
import { ENTRY_TYPE, readConfig, resolveSoul, sessionSoul, loadSoul, listSouls } from "../src/souls.ts";

const model = { provider: "provider", id: "model" };
const config = readConfig({ defaultSoul: "global", modelSouls: { "provider/model": "specific" } }, "/tmp");

test("session > exact model > global; clear and branch navigation replay from the session", () => {
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

test("loader reads one body, strips metadata, observes edits and rejects unsafe names", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-"));
  try {
    writeFileSync(join(dir, "faye.md"), "---\nname: Faye\n---\nOne body\n");
    assert.deepEqual(listSouls(dir), ["faye"]);
    assert.equal(loadSoul(dir, "faye"), "One body");
    writeFileSync(join(dir, "faye.md"), "Changed");
    assert.equal(loadSoul(dir, "faye"), "Changed");
    assert.throws(() => loadSoul(dir, "../secret"), /Invalid soul/);
    assert.throws(() => loadSoul(dir, "missing"), /ENOENT/);
    writeFileSync(join(dir, "empty.md"), "  ");
    assert.throws(() => loadSoul(dir, "empty"), /empty/);
    assert.throws(() => readConfig({ modelSouls: { model: "faye" } }, dir), /provider\/modelId/);
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

test("registered command persists selection, refuses missing files, and clear follows defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-command-"));
  try {
    writeFileSync(join(dir, "faye.md"), "Faye");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    let handler: (args: string, ctx: unknown) => Promise<void>;
    let project: (event: unknown, ctx: unknown) => unknown;
    const pi = {
      getSettings: () => ({ soulsDir: dir }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
      on: (_name: string, callback: typeof project) => { project = callback; },
    } as unknown as ExtensionAPI;
    extension(pi);
    const ctx = { cwd: dir, model, sessionManager: session, isIdle: () => true, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
    await handler!("faye", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    await handler!("missing", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    assert.match(notices.at(-1)!, /ENOENT/);
    assert.ok(project!({ messages: [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }] }, ctx));
    await handler!("clear", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    assert.equal(project!({ messages: [] }, ctx), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
