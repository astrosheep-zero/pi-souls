/// <reference path="../plugins/claude/types/claude-code.d.ts" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineInterface, On, PluginOptions, PromptComposeResult, PromptSubmitInput, PromptSubmitResult } from "claude-code";
import { register, replaceIdentity } from "../plugins/claude/hooks/register.ts";

// Exercise the actual compose and submit hooks with only host IO stubbed.
type Hook = ($: EngineInterface, event: any, next: any) => Promise<any>;
function host(options: PluginOptions = { defaultSoul: "faye", modelSouls: ["claude-test=reviewer"], timeaware: false }) {
  const hooks = new Map<string, Hook>();
  const files = new Map<string, string>([
    ["/home/.agents/souls/faye.md", "---\nname: Faye\n---\nYou are Faye. $&\n\nKeep your own voice.\n"],
    ["/home/.agents/souls/reviewer.md", "You are a reviewer."],
  ]);
  const env = new Map<string, string>([["HOME", "/home"]]);
  const warnings: string[] = [];
  let now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  let sessionId = "session-a";
  let currentModel = "claude-other";
  const $ = {
    clock: { now: async () => now },
    env: { get: async (key: string) => env.get(key) },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => { if (!files.has(path)) throw new Error("unreadable"); return files.get(path)!; },
    },
    session: {
      id: async () => sessionId,
      model: async () => currentModel,
    },
    ui: { log: (text: string) => { warnings.push(text); } },
  } as unknown as EngineInterface;
  register(((event: string, hook: Hook) => { hooks.set(event, hook); }) as unknown as On, options);
  assert.deepEqual([...hooks.keys()], [
    "classic.SessionStart", "classic.PreToolUse", "classic.PostToolUse", "classic.PostToolUseFailure",
    "prompt.compose", "prompt.submit", "session.end",
  ]);
  const compose = (result: PromptComposeResult, lean = false, model = "claude-other"): Promise<PromptComposeResult> =>
    hooks.get("prompt.compose")!($, { model, traits: lean ? ["lean"] : [] }, async () => result);
  const submit = (
    overrides: Partial<PromptSubmitInput> & { drop?: boolean; strip?: boolean; reject?: boolean } = {},
    next: (e: PromptSubmitInput) => Promise<PromptSubmitResult> = async (e) => ({ text: e.text, context: e.context, origin: e.origin }),
  ): Promise<PromptSubmitResult> =>
    hooks.get("prompt.submit")!($, { text: "hello", wait: false, origin: { kind: "composer" }, ...overrides }, async (e: any) => {
      if (overrides.reject) throw new Error("blocked");
      if (overrides.drop) return { drop: "no" };
      if (overrides.strip) return { text: e.text, context: overrides.context, origin: e.origin };
      return next(e);
    });
  const end = () => hooks.get("session.end")!($, {}, async (e: any) => e);
  return {
    files, env, warnings, compose, submit, end, options,
    setNow: (value: number) => { now = value; },
    getNow: () => now,
    setSession: (id: string) => { sessionId = id; },
    setModel: (model: string) => { currentModel = model; },
    setSessionModel: (model: string) => { currentModel = model; },
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

  h.setModel("claude-test");
  await h.compose(original, false, "claude-test"); // host evidence: reviewer is now in the prompt
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test\nnew soul: reviewer"]);
  assert.equal((await h.submit()).context, undefined);
});

test("Claude omits a soul cue when prompt.compose has no evidence it applied one", async () => {
  const h = host();
  await h.compose(original);
  await h.submit(); // baseline faye

  h.setModel("claude-test");
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test"]); // frozen snapshot: no compose evidence
  assert.equal((await h.submit()).context, undefined);

  await h.compose(original, false, "claude-test"); // now reviewer is actually composed
  assert.deepEqual((await h.submit()).context, ["new soul: reviewer"]);
});

test("Claude does not trust a compose that skipped the opening or failed to load", async () => {
  const h = host();
  await h.compose(original);
  await h.submit();
  h.setModel("claude-test");

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
  h.setModel("claude-test");
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
  dropped.setModel("claude-test");
  await dropped.compose(original, false, "claude-test");
  assert.equal((await dropped.submit()).context, undefined); // accepted prompt is the baseline
  dropped.setModel("claude-other");
  await dropped.compose(original);
  assert.deepEqual((await dropped.submit()).context, ["new brain: claude-other\nnew soul: faye"]);

  const rejected = host();
  await rejected.compose(original);
  await assert.rejects(rejected.submit({ reject: true }), /blocked/);
  rejected.setModel("claude-test");
  await rejected.compose(original, false, "claude-test");
  assert.equal((await rejected.submit()).context, undefined);
});

test("Claude keeps one baseline per session and clears it at session end", async () => {
  const h = host();
  await h.compose(original);
  await h.submit();
  h.setSession("session-b");
  h.setModel("claude-test");
  await h.compose(original, false, "claude-test");
  assert.equal((await h.submit()).context, undefined);
  h.setSession("session-a");
  await h.compose(original, false, "claude-test");
  assert.deepEqual((await h.submit()).context, ["new brain: claude-test\nnew soul: reviewer"]);
  h.setSession("session-b");
  assert.equal((await h.submit()).context, undefined);

  await h.end();
  h.setModel("claude-other");
  await h.compose(original);
  assert.equal((await h.submit()).context, undefined);
});

test("Claude never announces a soul that failed to compose", async () => {
  const h = host({ defaultSoul: "faye", modelSouls: ["claude-broken=missing"], timeaware: false });
  await h.compose(original);
  await h.submit();
  h.setModel("claude-broken");
  assert.equal(await h.compose(original, false, "claude-broken"), original);
  assert.deepEqual((await h.submit()).context, ["new brain: claude-broken"]);
  h.files.set("/home/.agents/souls/missing.md", "You are missing.");
  assert.match((await h.compose(original, false, "claude-broken")).sections[0].text, /missing/);
  assert.deepEqual((await h.submit()).context, ["new soul: missing"]);
});

test("Claude timeaware: false disables time reminders without affecting soul projection", async () => {
  const h = host({ defaultSoul: "faye", timeaware: false });
  assert.deepEqual((await h.submit({ context: ["earlier"] })).context, ["earlier"]);
  assert.match((await h.compose(original)).sections[0].text, /Faye/);
});

test("Claude prompt.submit refreshes the watch hourly by default and notes the human's absence only after >= 1h", async () => {
  const h = host({ defaultSoul: "faye" });
  const t0 = h.getNow();

  // First prompt in session gets current time without double-wrapping <system-reminder>.
  const first = await h.submit({ context: ["earlier"] });
  assert.equal(first.context?.length, 2);
  assert.equal(first.context?.[0], "earlier");
  assert.equal(first.context![1], "⌚ 02:14 · Tue, Oct 27");

  // Within 1 hour of the note: no time context, but the human's presence still advances.
  h.setNow(t0 + 40 * 60_000);
  const withinHour = await h.submit();
  assert.equal(withinHour.context, undefined);

  // 80m after the note: clock is due for a refresh, but the human spoke 40m ago — one-liner, no parenthetical.
  h.setNow(t0 + 80 * 60_000);
  const refresh = await h.submit();
  assert.equal(refresh.context?.length, 1);
  assert.equal(refresh.context![0], "⌚ 03:34 · Tue, Oct 27");

  // 3 hours later with no prompt in between: clock due and human away — both lines.
  h.setNow(t0 + 80 * 60_000 + 3 * 3_600_000);
  const afterThreeHours = await h.submit();
  assert.equal(afterThreeHours.context?.length, 1);
  assert.match(afterThreeHours.context![0]!, /^⌚ .*\n\(3h since \*human\* was last present\)$/);

  // Slash commands, meta prompts, dropped prompts, and soulless sessions do not inject or advance.
  h.setNow(t0 + 10 * 3_600_000);
  assert.equal((await h.submit({ command: { name: "help", args: "" } })).context, undefined);
  assert.equal((await h.submit({ isMeta: true })).context, undefined);
  h.env.set("SOULLESS", "1");
  assert.equal((await h.submit()).context, undefined);
  h.env.set("SOULLESS", "0");
  const dropped = await h.submit({}, async () => ({ drop: "blocked" }));
  assert.equal(dropped.drop, "blocked");
  // Because the dropped prompt did not enter, the next accepted prompt still sees the gap.
  const accepted = await h.submit();
  assert.equal(accepted.context?.length, 1);
  assert.match(accepted.context![0]!, /since \*human\* was last present\)$/);
});

test("Claude loads a directory soul and prefers its SOUL.md over a same-named file", async () => {
  const h = host();
  h.files.set("/home/.agents/souls/faye/SOUL.md", "---\nicon: \u{1F988}\n---\nYou are Directory Faye.");
  assert.match((await h.compose(original)).sections[0].text, /Directory Faye/);
  h.files.delete("/home/.agents/souls/faye/SOUL.md");
  assert.match((await h.compose(original)).sections[0].text, /You are Faye/);
});

const REACTION = `export function reaction(moment, world) {
  return { text: JSON.stringify({ moment, world }), audience: moment.kind === "human" ? "both" : "model" };
}
`;

// The reaction path is a real file and a real child process: only the engine's IO is stubbed.
function diskHost(reaction: Record<string, string> | string, options: PluginOptions = { defaultSoul: "faye", timeaware: false }) {
  const home = mkdtempSync(join(tmpdir(), "claude-reaction-"));
  const souls = join(home, ".agents", "souls", "faye");
  mkdirSync(souls, { recursive: true });
  writeFileSync(join(souls, "SOUL.md"), "You are Faye.");
  for (const [name, text] of Object.entries(typeof reaction === "string" ? { "reaction.ts": reaction } : reaction)) writeFileSync(join(souls, name), text);
  const hooks = new Map<string, Hook>();
  const toasts: string[] = [];
  const env = new Map<string, string>([["HOME", home]]);
  let now = new Date(2026, 9, 27, 2, 14, 0).getTime();
  const session = { id: "session-a", model: "claude-test", cwd: "/work" };
  const $ = {
    clock: { now: async () => now },
    env: { get: async (key: string) => env.get(key) },
    fs: { exists: async (path: string) => existsSync(path), read: async (path: string) => readFileSync(path, "utf8") },
    session: { id: async () => session.id, model: async () => session.model, cwd: async () => session.cwd },
    ui: { log: () => {}, toast: (text: string) => { toasts.push(text); } },
    process: {
      run: async (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => {
        const child = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", cwd: init?.cwd, timeout: init?.timeoutMs ?? 20_000 });
        return { exitCode: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "", isStdoutTruncated: false, isStderrTruncated: false };
      },
    },
  } as unknown as EngineInterface;
  register(((event: string, hook: Hook) => { hooks.set(event, hook); }) as unknown as On, options);
  const classic = (name: string, event: Record<string, unknown>, answer: Record<string, unknown> = {}) =>
    hooks.get(name)!($, event, async (_e: unknown) => ({ ...answer }));
  return {
    home, souls, toasts, env, session,
    fire: (name: string, event: Record<string, unknown>) => hooks.get(name)!($, { session_id: session.id, transcript_path: "", cwd: session.cwd, ...event }, async (x: any) => x),
    classic,
    submit: (event: Partial<PromptSubmitInput> = {}) =>
      hooks.get("prompt.submit")!($, { text: "hello", wait: false, origin: { kind: "composer" }, ...event }, async (x: any) => ({ text: x.text, context: x.context, origin: x.origin })),
    at: (value: number) => { now = value; },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

const momentOf = (entry: string | undefined) => JSON.parse(entry!).moment;

test("Claude wakes a directory soul's reaction with the world it can see", async () => {
  const h = diskHost(REACTION);
  try {
    const result = await h.classic("classic.SessionStart", { hook_event_name: "SessionStart", source: "resume", seconds_since_last_response: 120 });
    assert.equal(result.additionalContext.length, 1);
    assert.equal(h.toasts.length, 0);
    const { moment, world } = JSON.parse(result.additionalContext[0]);
    assert.deepEqual(moment, { kind: "wake", source: "resume" });
    assert.equal(world.now, new Date(2026, 9, 27, 2, 14, 0).getTime());
    assert.equal(world.sessionId, "session-a");
    assert.equal(world.cwd, "/work");
    assert.equal(world.absenceMs, 120_000);
    assert.equal(world.storeDir, `${h.home}/.local/share/pi-souls/faye`);
    assert.deepEqual([world.facts.hour, world.facts.night, world.facts.weekday, world.facts.weekend], [2, true, 2, false]);

    // Nothing to resume: no absence is invented.
    const fresh = await h.classic("classic.SessionStart", { hook_event_name: "SessionStart", source: "clear" });
    assert.equal(JSON.parse(fresh.additionalContext[0]).world.absenceMs, undefined);
    assert.deepEqual(momentOf(fresh.additionalContext[0]), { kind: "wake", source: "clear" });
  } finally { h.close(); }

  // A plain ES module works the same way: the runner reads `reaction` or the default export.
  const esm = diskHost({ "reaction.mjs": "export default (moment) => ({ text: `mjs:${moment.source}` });" });
  try {
    const result = await esm.classic("classic.SessionStart", { hook_event_name: "SessionStart", source: "startup" });
    assert.deepEqual(result.additionalContext, ["mjs:startup"]);
  } finally { esm.close(); }
});

test("Claude hands the human's prompt to the reaction and appends what the model should read", async () => {
  const h = diskHost(REACTION);
  try {
    const result = await h.submit({ text: "what now", context: ["earlier"] });
    assert.deepEqual(result.context?.slice(0, 1), ["earlier"]);
    const said = JSON.parse(result.context!.at(-1)!);
    assert.deepEqual(said.moment, { kind: "human", text: "what now" });
    assert.equal(said.world.sessionId, "session-a");
    assert.equal(h.toasts.length, 1); // `both` reaches the human too
    assert.equal(JSON.parse(h.toasts[0]!).moment.text, "what now");

    // The next prompt learns how long the human was away.
    h.at(new Date(2026, 9, 27, 2, 14, 0).getTime() + 90_000);
    const next = await h.submit({ text: "again" });
    assert.equal(JSON.parse(next.context!.at(-1)!).world.absenceMs, 90_000);
  } finally { h.close(); }
});

test("Claude answers tool calls on both phases and keeps the host's own context", async () => {
  const h = diskHost(REACTION);
  try {
    const before = await h.classic("classic.PreToolUse", { tool: "Read", tool_use_id: "t1", file_path: "/work/a.md" }, { additionalContext: ["host"] });
    assert.deepEqual(before.additionalContext[0], "host");
    const pre = JSON.parse(before.additionalContext[1]);
    assert.deepEqual(pre.moment, {
      kind: "tool", phase: "before", category: "reading", toolName: "Read",
      filePath: "/work/a.md", input: JSON.stringify({ file_path: "/work/a.md" }),
    });

    const after = await h.classic("classic.PostToolUse", {
      hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/work/b.md", old_string: "a", new_string: "b" }, tool_response: "done", tool_use_id: "t2",
    }, { additionalContext: ["host"] });
    const post = JSON.parse(after.additionalContext[1]);
    assert.equal(post.moment.phase, "after");
    assert.equal(post.moment.category, "writing");
    assert.equal(post.moment.filePath, "/work/b.md");
    assert.equal(post.moment.output, "done");
    assert.equal(post.moment.ok, true);

    const failed = await h.classic("classic.PostToolUseFailure", {
      hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "false" }, error: "exit 1", tool_use_id: "t3",
    });
    const fail = JSON.parse(failed.additionalContext[0]);
    assert.deepEqual([fail.moment.phase, fail.moment.category, fail.moment.ok, fail.moment.output], ["after", "running", false, "exit 1"]);
  } finally { h.close(); }
});

test("Claude keeps silence when soulless, without a reaction, or the reaction module is broken", async () => {
  const soulless = diskHost(REACTION);
  try {
    soulless.env.set("SOULLESS", "1");
    const result = await soulless.classic("classic.SessionStart", { hook_event_name: "SessionStart", source: "startup" });
    assert.equal(result.additionalContext, undefined);
    assert.equal((await soulless.submit()).context, undefined);
  } finally { soulless.close(); }

  const plain = diskHost({});
  try {
    assert.equal((await plain.classic("classic.SessionStart", { hook_event_name: "SessionStart", source: "startup" })).additionalContext, undefined);
  } finally { plain.close(); }

  const broken = diskHost({ "reaction.ts": "export const reaction = () => { throw new Error('boom'); };" });
  try {
    assert.equal((await broken.classic("classic.SessionStart", { hook_event_name: "SessionStart", source: "startup" })).additionalContext, undefined);
    assert.equal((await broken.submit()).context, undefined);
  } finally { broken.close(); }
});

test("Claude hooks typecheck without Node globals", () => {
  const result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "plugins/claude/tsconfig.json"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
