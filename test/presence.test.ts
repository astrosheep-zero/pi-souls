import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "../src/presence.ts";

const first = { provider: "provider", id: "first" };
const second = { provider: "provider", id: "second" };
type Renderer = (entry: { data?: unknown }, options: unknown, theme: { fg: (color: string, text: string) => string }) => { render: (width: number) => string[] } | undefined;

function setup(files: Record<string, string>, settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "souls-presence-"));
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  for (const [name, text] of Object.entries(files)) write(name, text);
  const previousSoulless = process.env.SOULLESS;
  delete process.env.SOULLESS;

  const session = SessionManager.inMemory();
  const statuses = new Map<string, string>();
  const notices: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const renderers = new Map<string, Renderer>();
  let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
  let flag = false;
  let prompt: string | undefined;
  const current = { ...first };
  const config: Record<string, unknown> = { soulsDir: dir, ...settings };

  const pi = {
    registerFlag: () => {},
    getFlag: () => flag,
    getSettings: () => config,
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    registerCommand: (_name: string, registered: typeof command) => { command = registered; },
    registerEntryRenderer: (type: string, renderer: unknown) => { renderers.set(type, renderer as Renderer); },
    on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, callback); },
  } as unknown as ExtensionAPI;
  extension(pi);

  const ctx = {
    cwd: dir, model: current, sessionManager: session, isIdle: () => true, hasUI: true,
    getSystemPromptOptions: () => ({ cwd: dir, customPrompt: prompt }),
    ui: {
      notify: (text: string, type = "info") => notices.push(`${type}: ${text}`),
      setStatus: (key: string, text: string | undefined) => { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
    },
  } as unknown as ExtensionContext;

  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const beforeAgent = (customPrompt?: string) => fire("before_agent_start", { systemPromptOptions: { cwd: dir, customPrompt } });
  const request = (messages: unknown[] = [{ role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 0 }]) => fire("context_with_system", { messages });
  const dividers = () => session.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === PRESENCE_ENTRY_TYPE ? [entry.data] : []);
  const renderDividerLines = (data: unknown, width = 80) => {
    const renderer = renderers.get(PRESENCE_ENTRY_TYPE);
    const component = renderer?.({ data }, { expanded: false }, { fg: (_color: string, text: string) => text });
    return component?.render(width);
  };
  const renderDivider = (data: unknown) => renderDividerLines(data)?.[0]?.trimEnd();

  return {
    dir, session, statuses, notices, handlers, command, ctx, current, config,
    write, fire, beforeAgent, request, dividers, renderDivider, renderDividerLines,
    status: () => statuses.get(FOOTER_KEY),
    setPrompt: (value: string | undefined) => { prompt = value; },
    setSoulless: (value: boolean) => { flag = value; },
    useModel: (model: { provider: string; id: string }) => { current.provider = model.provider; current.id = model.id; },
    done: () => {
      if (previousSoulless === undefined) delete process.env.SOULLESS; else process.env.SOULLESS = previousSoulless;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("settings/model footer waits for host prompt options; a session choice does not", async () => {
  const h = setup({
    "faye.md": "---\nicon: 🦈\n---\nFaye",
    "global.md": "Global",
  }, { defaultSoul: "global", modelSouls: { "provider/first": "faye" } });
  try {
    h.fire("session_start");
    assert.equal(h.status(), undefined);
    h.useModel(first);
    h.fire("model_select", { model: first });
    assert.equal(h.status(), undefined);

    h.beforeAgent(undefined);
    assert.equal(h.status(), "🦈");

    h.fire("session_start");
    assert.equal(h.status(), undefined);
    await h.command.handler("faye", h.ctx);
    assert.equal(h.status(), "🦈");
    h.fire("session_start");
    assert.equal(h.status(), "🦈");
  } finally { h.done(); }
});

test("footer shows a nonempty icon alone and falls back to the soul name", () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye" }, { defaultSoul: "faye" });
  try {
    h.beforeAgent(undefined);
    assert.equal(h.status(), "🦈");

    h.write("faye.md", "---\nicon: 42\n---\nFaye");
    h.beforeAgent(undefined);
    assert.equal(h.status(), "faye");

    h.write("faye.md", "---\nicon: '  '\n---\nFaye");
    h.beforeAgent(undefined);
    assert.equal(h.status(), "faye");

    h.write("faye.md", "---\nname: Faye\n---\nFaye");
    h.beforeAgent(undefined);
    assert.equal(h.status(), "faye");
  } finally { h.done(); }
});

test("footer follows model/default/session/customPrompt precedence and survives branch navigation", async () => {
  const h = setup({
    "global.md": "---\nicon: 🌍\n---\nGlobal",
    "specific.md": "Specific",
    "faye.md": "---\nicon: 🦈\n---\nFaye",
  }, { defaultSoul: "global", modelSouls: { "provider/first": "specific" } });
  const root = h.session.appendCustomEntry("unrelated", {});
  try {
    h.useModel(second);
    h.fire("session_start");
    assert.equal(h.status(), undefined);

    h.beforeAgent(undefined);
    assert.equal(h.status(), "🌍");

    h.useModel(first);
    h.fire("model_select", { model: first });
    assert.equal(h.status(), "specific");

    h.setPrompt("My prompt");
    h.fire("before_agent_start", { systemPromptOptions: { cwd: h.dir, customPrompt: "My prompt" } });
    assert.equal(h.status(), undefined);

    await h.command.handler("faye", h.ctx);
    assert.equal(h.status(), "🦈");

    h.setPrompt("");
    h.beforeAgent("");
    assert.equal(h.status(), "🦈");

    h.session.branch(root);
    h.fire("session_tree");
    assert.equal(h.status(), "specific");

    h.session.appendCustomEntry("unrelated", {});
    h.useModel(second);
    h.fire("model_select", { model: second });
    assert.equal(h.status(), "🌍");
  } finally { h.done(); }
});

test("no effective soul clears the footer and an unreadable soul never leaves stale success", () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye" }, { defaultSoul: "faye" });
  try {
    h.beforeAgent(undefined);
    assert.equal(h.status(), "🦈");
    rmSync(join(h.dir, "faye.md"));
    h.fire("model_select", { model: first });
    assert.equal(h.status(), undefined);

    h.fire("session_start");
    assert.equal(h.status(), undefined);
    assert.equal(h.notices.length, 0);
  } finally { h.done(); }
});

test("request boundaries refresh the footer, including settings changes", () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye", "reviewer.md": "Reviewer" }, { defaultSoul: "faye" });
  try {
    h.beforeAgent(undefined);
    assert.equal(h.status(), "🦈");
    h.config.defaultSoul = "reviewer";
    assert.ok(h.request());
    assert.equal(h.status(), "reviewer");
  } finally { h.done(); }
});

test("failed projection removes the active badge", () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye" }, { defaultSoul: "faye" });
  try {
    h.beforeAgent(undefined);
    assert.equal(h.status(), "🦈");
    h.request([{ role: "system", content: "plain", timestamp: 0 }]);
    assert.equal(h.status(), undefined);
    assert.match(h.notices.at(-1)!, /^warning: Soul skipped/);

    assert.ok(h.request());
    assert.equal(h.status(), "🦈");
    h.fire("before_agent_start", { systemPromptOptions: { cwd: h.dir, forceSystemPrompt: "No identity" } });
    h.request();
    assert.equal(h.status(), undefined);
    assert.match(h.notices.at(-1)!, /^warning: Soul: replacement failed/);
  } finally { h.done(); }
});

test("divider lines fit the requested terminal width", () => {
  const h = setup({});
  try {
    const lines = h.renderDividerLines({ version: 1, name: "a-very-long-soul-name" }, 12)!;
    assert.ok(lines.length > 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= 12));
  } finally { h.done(); }
});

test("clear to a missing default reports soulless, not a false soul", async () => {
  const h = setup({ "faye.md": "Faye" }, { defaultSoul: "missing" });
  try {
    await h.command.handler("faye", h.ctx);
    await h.command.handler("clear", h.ctx);
    assert.deepEqual(h.dividers(), [{ version: 1, name: "faye" }, { version: 1, name: null }]);
    assert.equal(h.renderDivider(h.dividers().at(-1)), "── soulless ──");
    assert.equal(h.status(), undefined);
    assert.match(h.notices.at(-1)!, /^info: Cleared\. Soul: missing \(default\)/);
  } finally { h.done(); }
});

test("dividers mark real identity changes only", async () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye", "reviewer.md": "Reviewer" }, { defaultSoul: "reviewer" });
  try {
    await h.command.handler("faye", h.ctx);
    assert.deepEqual(h.dividers(), [{ version: 1, name: "faye" }]);
    assert.equal(h.renderDivider(h.dividers()[0]), "── soul: faye ──");

    const afterSelect = h.session.getBranch().length;
    await h.command.handler("faye", h.ctx);
    assert.equal(h.session.getBranch().length, afterSelect);
    await h.command.handler("", h.ctx);
    assert.equal(h.session.getBranch().length, afterSelect);
    await h.command.handler("missing", h.ctx);
    assert.equal(h.session.getBranch().length, afterSelect);
    assert.equal(h.dividers().length, 1);
    assert.match(h.notices.at(-1)!, /^error: No soul "missing"/);

    await h.command.handler("clear", h.ctx);
    assert.deepEqual(h.dividers().at(-1), { version: 1, name: "reviewer" });
    assert.equal(h.renderDivider(h.dividers().at(-1)), "── soul: reviewer ──");
    assert.equal(h.status(), "reviewer");

    const afterClear = h.session.getBranch().length;
    await h.command.handler("clear", h.ctx);
    assert.equal(h.session.getBranch().length, afterClear);
  } finally { h.done(); }
});

test("clear to no soul is soulless, while clear back to the same default adds no divider", async () => {
  const none = setup({ "faye.md": "Faye" });
  try {
    await none.command.handler("faye", none.ctx);
    await none.command.handler("clear", none.ctx);
    assert.deepEqual(none.dividers(), [{ version: 1, name: "faye" }, { version: 1, name: null }]);
    assert.equal(none.renderDivider(none.dividers().at(-1)), "── soulless ──");
    assert.equal(none.status(), undefined);
  } finally { none.done(); }

  const same = setup({ "faye.md": "Faye" }, { defaultSoul: "faye" });
  try {
    await same.command.handler("faye", same.ctx);
    await same.command.handler("clear", same.ctx);
    assert.deepEqual(same.dividers(), []);
  } finally { same.done(); }
});

test("clear under a custom prompt is soulless because settings souls stay off", async () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye" }, { defaultSoul: "faye" });
  try {
    h.setPrompt("My prompt");
    await h.command.handler("faye", h.ctx);
    assert.equal(h.status(), "🦈");
    await h.command.handler("clear", h.ctx);
    assert.deepEqual(h.dividers().at(-1), { version: 1, name: null });
    assert.equal(h.status(), undefined);
  } finally { h.done(); }
});

test("stored dividers replay their own facts and never enter model context", async () => {
  const h = setup({ "faye.md": "---\nicon: 🦈\n---\nFaye", "reviewer.md": "Reviewer" }, { defaultSoul: "reviewer" });
  try {
    h.fire("session_start");
    await h.command.handler("faye", h.ctx);
    const stored = h.dividers()[0];
    rmSync(join(h.dir, "faye.md"));
    h.fire("session_start");
    assert.equal(h.renderDivider(stored), "── soul: faye ──");
    assert.equal(h.renderDivider({ version: 1, name: "../secret" }), undefined);
    assert.equal(h.renderDivider({ version: 2, name: "faye" }), undefined);
    assert.equal(h.renderDivider(null), undefined);

    assert.ok(h.session.getBranch().some((entry) => entry.type === "custom" && entry.customType === PRESENCE_ENTRY_TYPE));
    assert.ok(!h.session.buildSessionProjection().messages.some((message) => JSON.stringify(message).includes("── soul")));
  } finally { h.done(); }
});
