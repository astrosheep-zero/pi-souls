/// <reference path="../plugins/claude/types/claude-code.d.ts" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { EngineInterface, On, PluginOptions, PromptComposeResult } from "claude-code";
import { register, replaceIdentity } from "../plugins/claude/hooks/register.ts";

// Exercise the actual compose hook with only host IO stubbed.
type Hook = ($: EngineInterface, event: any, next: any) => Promise<any>;
function host(options: PluginOptions = { defaultSoul: "faye", modelSouls: ["claude-test=reviewer"] }) {
  const hooks = new Map<string, Hook>();
  const files = new Map<string, string>([
    ["/home/.agents/souls/faye.md", "---\nname: Faye\n---\nYou are Faye. $&\n\nKeep your own voice.\n"],
    ["/home/.agents/souls/reviewer.md", "You are a reviewer."],
  ]);
  const env = new Map<string, string>([["HOME", "/home"]]);
  const warnings: string[] = [];
  let sessionId = "session-a";
  let sessionModel = "claude-other";
  const $ = {
    env: { get: async (key: string) => env.get(key) },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => { if (!files.has(path)) throw new Error("unreadable"); return files.get(path)!; },
    },
    session: { id: async () => sessionId, model: async () => sessionModel },
    ui: { log: (text: string) => { warnings.push(text); } },
  } as unknown as EngineInterface;
  register(((event: string, hook: Hook) => { hooks.set(event, hook); }) as unknown as On, options);
  assert.deepEqual([...hooks.keys()], ["prompt.compose", "prompt.submit", "session.end"]);
  const compose = (result: PromptComposeResult, lean = false, model = "claude-other"): Promise<PromptComposeResult> =>
    hooks.get("prompt.compose")!($, { model, traits: lean ? ["lean"] : [] }, async () => result);
  const submit = (input: { command?: { name: string; args: string }; isMeta?: true; context?: string[]; drop?: boolean; strip?: boolean; reject?: boolean } = {}) =>
    hooks.get("prompt.submit")!($, { text: "hi", wait: false, origin: { kind: "composer" }, ...input }, async (e: any) => {
      if (input.reject) throw new Error("blocked");
      if (input.drop) return { drop: "no" };
      return { text: e.text, context: input.strip ? input.context : e.context };
    });
  const end = () => hooks.get("session.end")!($, {}, async (e: any) => e);
  return {
    files, env, warnings, compose, submit, end,
    setSession: (id: string) => { sessionId = id; },
    setSessionModel: (model: string) => { sessionModel = model; },
    options,
  };
}
const original: PromptComposeResult = {
  sections: Object.freeze([
    Object.freeze({ id: "intro", text: "\nYou are a coding agent.\n\nIMPORTANT: Keep this.\n", scope: "shared" as const }),
    Object.freeze({ id: "tools", text: "Tools untouched", scope: "shared" as const }),
    Object.freeze({ id: "rules", text: "Project rules untouched", scope: "session" as const }),
  ]),
};

test("Claude default and lean replace only the opening paragraph, preserving every other character", async () => {
  const h = host();
  const before = structuredClone(original);
  const output = await h.compose(original);
  assert.deepEqual(original, before);
  assert.equal(output.sections[0].text, "\nYou are Faye. $&\n\nKeep your own voice.\n\nIMPORTANT: Keep this.\n");
  assert.equal(output.sections[1], original.sections[1]);
  assert.equal(output.sections[2], original.sections[2]);
  const lean = { sections: [{ ...original.sections[0], id: "lean_body", text: "You are a lean agent.\r\n \r\nRules\r\n" }, ...original.sections.slice(1)] };
  const leanOutput = await h.compose(lean, true);
  assert.equal(leanOutput.sections[0].text, "You are Faye. $&\n\nKeep your own voice.\r\n \r\nRules\r\n");
  assert.equal(leanOutput.sections[1], lean.sections[1]);
  assert.equal(replaceIdentity("You are an agent.", "Soul"), "Soul");
  assert.equal(replaceIdentity("Rules first.\n\nYou are later.", "Soul"), undefined);
});

test("Claude missing or changed opening falls back unchanged and warns once, not per request", async () => {
  const h = host();
  const changed = { sections: [{ ...original.sections[0], text: "Changed opening\n\nKeep all of it" }] };
  const missing = { sections: original.sections.slice(1) };
  for (const input of [changed, changed, missing, original, changed]) {
    const result = await h.compose(input);
    if (input !== original) assert.equal(result, input);
  }
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings[0], /intro|lean_body/);
});

test("Claude SOULLESS > exact model > default; omitted options leave the prompt alone", async () => {
  const h = host();
  assert.equal((await h.compose(original, false, "claude-test")).sections[0].text, "\nYou are a reviewer.\n\nIMPORTANT: Keep this.\n");
  assert.match((await h.compose(original, false, "claude-test-extra")).sections[0].text, /Faye/);
  for (const value of ["1", "true"]) {
    h.env.set("SOULLESS", value);
    assert.equal(await h.compose(original, false, "claude-test"), original);
  }
  h.env.set("SOULLESS", "0");
  assert.notEqual(await h.compose(original), original);
  assert.equal(await host({}).compose(original), original);
});

test("Claude malformed model entries warn once and are ignored individually", async () => {
  const h = host({ defaultSoul: "faye", modelSouls: ["bad-format", "claude-test=../escape", "claude-test=reviewer"] });
  for (let i = 0; i < 2; i++) {
    assert.match((await h.compose(original, false, "claude-test")).sections[0].text, /reviewer/);
    assert.match((await h.compose(original)).sections[0].text, /Faye/);
  }
  assert.equal(h.warnings.length, 2);
  assert.ok(h.warnings.every((warning) => warning.includes("Ignoring invalid model entry")));
});

test("Claude unreadable/empty soul leaves core prompt intact and deduplicates the error", async () => {
  const h = host();
  h.files.set("/home/.agents/souls/faye.md", "---\nname: Faye\n---\n");
  assert.equal(await h.compose(original), original);
  assert.equal(await h.compose(original), original);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /empty/);
  h.files.set("/home/.agents/souls/faye.md", "You are repaired.");
  assert.match((await h.compose(original)).sections[0].text, /repaired/);
});

test("Claude transition context is exact, separate per session, and quiet on the first prompt", async () => {
  const h = host();
  await h.compose(original); // host evidence: faye is actually in the prompt
  assert.equal((await h.submit()).context, undefined); // baseline

  h.setSessionModel("claude-test");
  await h.compose(original, false, "claude-test"); // host evidence: reviewer is now in the prompt
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test\nnew soul: reviewer"]);
  assert.equal((await h.submit()).context, undefined);
});

test("Claude omits a soul cue when prompt.compose has no evidence it applied one", async () => {
  const h = host();
  await h.compose(original);
  await h.submit(); // baseline faye

  h.setSessionModel("claude-test");
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test"]); // frozen snapshot: no compose evidence
  assert.equal((await h.submit()).context, undefined);

  await h.compose(original, false, "claude-test"); // now reviewer is actually composed
  assert.deepEqual((await h.submit()).context, ["new soul: reviewer"]);
});

test("Claude does not trust a compose that skipped the opening or failed to load", async () => {
  const h = host();
  await h.compose(original);
  await h.submit();
  h.setSessionModel("claude-test");

  const changed = { sections: [{ ...original.sections[0], text: "Changed opening\n\nKeep all of it" }] };
  assert.equal(await h.compose(changed, false, "claude-test"), changed);
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test"]);

  h.files.set("/home/.agents/souls/reviewer.md", "You are repaired.");
  assert.match((await h.compose(original, false, "claude-test")).sections[0].text, /repaired/);
  assert.deepEqual((await h.submit()).context, ["new soul: reviewer"]);
});

test("Claude command, meta, drop and stripped context do not consume the cue", async () => {
  const h = host();
  await h.compose(original);
  await h.submit();
  h.setSessionModel("claude-test");
  await h.compose(original, false, "claude-test");

  assert.equal((await h.submit({ command: { name: "compact", args: "" } })).context, undefined);
  assert.equal((await h.submit({ isMeta: true })).context, undefined);
  assert.deepEqual((await h.submit({ drop: true })).drop, "no");
  await assert.rejects(h.submit({ reject: true }), /blocked/);
  assert.equal((await h.submit({ strip: true })).context, undefined);
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test\nnew soul: reviewer"]);
});

test("Claude does not establish a baseline until the first prompt is accepted", async () => {
  const dropped = host();
  await dropped.compose(original);
  assert.deepEqual((await dropped.submit({ drop: true })).drop, "no");
  dropped.setSessionModel("claude-test");
  await dropped.compose(original, false, "claude-test");
  assert.equal((await dropped.submit()).context, undefined); // accepted prompt is the baseline
  dropped.setSessionModel("claude-other");
  await dropped.compose(original);
  assert.deepEqual((await dropped.submit()).context, ["new brain: claude-other\nnew soul: faye"]);

  const rejected = host();
  await rejected.compose(original);
  await assert.rejects(rejected.submit({ reject: true }), /blocked/);
  rejected.setSessionModel("claude-test");
  await rejected.compose(original, false, "claude-test");
  assert.equal((await rejected.submit()).context, undefined);
});

test("Claude keeps one baseline per session and clears it at session end", async () => {
  const h = host();
  await h.compose(original);
  await h.submit();
  h.setSession("session-b");
  h.setSessionModel("claude-test");
  await h.compose(original, false, "claude-test");
  assert.equal((await h.submit()).context, undefined);
  h.setSession("session-a");
  await h.compose(original, false, "claude-test");
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test\nnew soul: reviewer"]);
  h.setSession("session-b");
  assert.equal((await h.submit()).context, undefined);

  await h.end();
  h.setSessionModel("claude-other");
  await h.compose(original);
  assert.equal((await h.submit()).context, undefined);
});

test("Claude never announces a soul that failed to compose", async () => {
  const h = host({ defaultSoul: "faye", modelSouls: ["claude-broken=missing"] });
  await h.compose(original);
  await h.submit();
  h.setSessionModel("claude-broken");
  assert.equal(await h.compose(original, false, "claude-broken"), original);
  assert.deepEqual((await h.submit()).context, ["new brain: claude-broken"]);
  h.files.set("/home/.agents/souls/missing.md", "You are missing.");
  assert.match((await h.compose(original, false, "claude-broken")).sections[0].text, /missing/);
  assert.deepEqual((await h.submit()).context, ["new soul: missing"]);
});

test("Claude hooks typecheck without Node globals", () => {
  const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "plugins/claude/tsconfig.json"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
