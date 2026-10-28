import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";
import { listSouls, loadSoul, sessionSoul } from "../src/souls.ts";

const variables = { model: { provider: "openai", id: "gpt-test" }, cwd: "/tmp/<agent>&work" };

test("Liquid renders model conditions, variables, loops and literal template examples as plain text", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-template-"));
  try {
    writeFileSync(join(dir, "faye.md"), `---
ignored: '{{ unknown }}'
---
# Faye
{% if model.provider == "openai" %}GPT{% elsif model.provider == "anthropic" %}Claude{% else %}Other{% endif %}: {{ model.id }}
{{ cwd }}
{% assign names = "one,two" | split: "," %}{% for name in names %}[{{ name }}]{% endfor %}
{% raw %}{{ literal }}{% endraw %}`);
    assert.equal(loadSoul(dir, "faye", variables), "# Faye\nGPT: gpt-test\n/tmp/<agent>&work\n[one][two]\n{{ literal }}");
    assert.match(loadSoul(dir, "faye", { ...variables, model: { provider: "anthropic", id: "claude-test" } }), /Claude: claude-test/);
    assert.match(loadSoul(dir, "faye", { ...variables, model: { provider: "", id: "" } }), /Other:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("includes and render snippets share host variables, stay out of soul completion and observe edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-partials-"));
  try {
    mkdirSync(join(dir, "parts"));
    writeFileSync(join(dir, "faye.md"), `Faye\n{% include 'parts/shared' %}\n{% render 'parts/shared' %}`);
    writeFileSync(join(dir, "parts/shared.md"), "{{ model.id }} @ {{ cwd }}");
    assert.deepEqual(listSouls(dir), ["faye"]);
    assert.equal(loadSoul(dir, "faye", variables), `Faye\ngpt-test @ ${variables.cwd}\ngpt-test @ ${variables.cwd}`);
    writeFileSync(join(dir, "parts/shared.md"), "Changed {{ model.provider }}");
    assert.equal(loadSoul(dir, "faye", variables), "Faye\nChanged openai\nChanged openai");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("template errors identify the soul; invalid syntax, missing variables, filters, snippets and empty output fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-template-errors-"));
  try {
    for (const [body, expected] of [
      ["{% if true %}unfinished", /Soul "faye" template:.*not closed/],
      ["{{ model.typo }}", /Soul "faye" template:.*undefined variable/],
      ["{{ model.id | nonexistent }}", /Soul "faye" template:.*undefined filter/],
      ["{% include 'missing' %}", /Soul "faye" template:.*ENOENT/],
      ["{% if model.provider == 'other' %}Invisible{% endif %}", /Soul "faye" is empty/],
    ] as const) {
      writeFileSync(join(dir, "faye.md"), body);
      assert.throws(() => loadSoul(dir, "faye", variables), expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("commands validate templates before persisting; requests and forced prompts use rendered text and retain fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-template-hooks-"));
  try {
    writeFileSync(join(dir, "faye.md"), "Faye {{ model.id }} in {{ cwd }}");
    writeFileSync(join(dir, "broken.md"), "{{ model.typo }}");
    const session = SessionManager.inMemory();
    const notices: string[] = [];
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    let command!: { handler: (args: string, ctx: unknown) => Promise<void> };
    extension({
      registerFlag: () => {}, getFlag: () => false,
      getSettings: () => ({ soulsDir: dir }),
      appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
      registerEntryRenderer: () => {},
      registerCommand: (_name: string, registered: typeof command) => { command = registered; },
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    } as unknown as ExtensionAPI);
    const options = { cwd: dir, forceSystemPrompt: "Pi\nKeep these rules" };
    const ctx = {
      cwd: variables.cwd, model: { ...variables.model }, sessionManager: session, hasUI: true,
      isIdle: () => true, getSystemPromptOptions: () => options,
      ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
    };
    const input: AgentMessage[] = [{ role: "system", content: "", sections: { preamble: "Pi", rules: "Keep" }, timestamp: 0 }];
    const original = structuredClone(input);
    const request = () => handlers.get("context_with_system")![0]({ messages: input }, ctx) as { messages: AgentMessage[] } | undefined;

    await command.handler("broken", ctx);
    assert.equal(sessionSoul(session.getBranch()), undefined);
    assert.match(notices.at(-1)!, /template:.*undefined variable/);
    await command.handler("faye", ctx);
    assert.equal(sessionSoul(session.getBranch()), "faye");
    assert.ok(handlers.get("before_agent_start")![0]({ messageType: "user", systemPromptOptions: options }, ctx));
    const expected = `Faye gpt-test in ${variables.cwd}`;
    assert.deepEqual(request()!.messages[0], { ...input[0], sections: { preamble: expected, rules: "Keep" } });
    assert.equal(options.forceSystemPrompt, `${expected}\nKeep these rules`);
    assert.deepEqual(input, original);

    ctx.model.id = "other-model";
    assert.ok(request());
    assert.equal(options.forceSystemPrompt, `Faye other-model in ${variables.cwd}\nKeep these rules`);

    writeFileSync(join(dir, "faye.md"), "{{ model.typo }}");
    const count = notices.length;
    assert.equal(request(), undefined);
    assert.equal(request(), undefined);
    assert.equal(notices.length, count + 1);
    assert.equal(options.forceSystemPrompt, "Pi\nKeep these rules");
    assert.match(notices.at(-1)!, /Soul "faye" template:.*undefined variable/);
    assert.deepEqual(input, original);
    writeFileSync(join(dir, "faye.md"), "Repaired {{ model.id }}");
    assert.ok(request());
    assert.equal(options.forceSystemPrompt, "Repaired other-model\nKeep these rules");

    const projected = options.forceSystemPrompt;
    options.forceSystemPrompt = "Another plugin owns this prompt";
    writeFileSync(join(dir, "faye.md"), "{{ model.typo }}");
    assert.equal(request(), undefined);
    assert.equal(options.forceSystemPrompt, "Another plugin owns this prompt");
    options.forceSystemPrompt = projected;
    handlers.get("agent_settled")![0]({}, ctx);
    assert.equal(request(), undefined);
    assert.equal(options.forceSystemPrompt, projected); // Idle requests must not mutate stale run options.
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
