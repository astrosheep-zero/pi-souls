/// <reference path="../plugins/claude/types/claude-code.d.ts" />
/// <reference path="../plugins/claude/types/sandbox.d.ts" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { encodeChoice, readClaudeSession, type SoulChoice } from "../src/claude-session.ts";
import { openingParagraph, register, retainedMessages } from "../plugins/claude/hooks/register.ts";
import type { On, PromptComposeResult, SessionMessage } from "claude-code";

type Hook = ($: any, event: any, next: any) => any;
type HookEntry = { event: string; matcher?: Record<string, unknown>; hook: Hook };
type SoulFile = { body: string; icon?: string };

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const NATIVE = "\nYou are the native agent.\n\nIMPORTANT: Keep every native rule.\n";
const GUIDANCE = "Original session guidance.";

/**
 * Exercise the real hooks module with only the engine boundary stubbed. The
 * in-memory transcript is read back through the real readClaudeSession().
 */
function host(options: { souls?: Record<string, SoulFile>; defaultSoul?: string; timeaware?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-souls-hooks-"));
  roots.push(root);
  const souls = new Map<string, SoulFile>(Object.entries(options.souls ?? {
    A: { body: "You are soul A.", icon: "✦" },
    B: { body: "You are soul B." },
  }));

  const hooks: HookEntry[] = [];
  const transcript: any[] = [];
  const statuses: (string | undefined)[] = [];
  const invalidations: string[] = [];
  const logs: string[] = [];
  const commands: any[] = [];
  const sectionResults: { name: string; text: string | null }[] = [];
  let seq = 0;
  let lastUuid: string | undefined;
  let now = Date.UTC(2026, 10, 17, 11, 30, 0);
  let denyNote: string | undefined;
  let pendingAppend: { message: any; uuid: string } | undefined;
  let pauseWorld: (() => Promise<void>) | undefined;
  let pauseDiscovery: (() => Promise<void>) | undefined;
  let discoveries = 0;
  let spawns = 0;
  const streamEnded = { code: 0, signal: null };
  let releaseStream: (() => void) | undefined;

  const jsonl = () => transcript.map((row) => JSON.stringify(row)).join("\n") + (transcript.length ? "\n" : "");

  const rowFor = (message: any, uuid: string, parentUuid: string | null) => {
    const at = new Date(now += 1000).toISOString();
    const base = { uuid, parentUuid, timestamp: at, isSidechain: false };
    if (message.type === "system") {
      return { ...base, type: "system", subtype: message.subtype ?? "informational", content: message.content.map((block: any) => block.text ?? "").join("") };
    }
    if (message.type === "attachment") return { ...base, type: "attachment", attachment: message.attachment };
    return { ...base, type: message.type, message: { role: message.type, content: message.content, ...(message.model ? { model: message.model } : {}) } };
  };

  function save(message: any, uuid: string) {
    const parentUuid = lastUuid ?? null;
    lastUuid = uuid;
    transcript.push(rowFor(message, uuid, parentUuid));
    return { message, uuid };
  }

  const append = async (message: any, door: string, origin: any = { kind: "plugin", name: "pi-souls" }) => {
    if (door === "note" && denyNote !== undefined) return { deny: denyNote };
    const uuid = `row-${++seq}`;
    pendingAppend = { message, uuid };
    const event = { message, door, origin, uuid };
    const result = await invoke("session.append", event, async (e) => {
      pendingAppend = undefined;
      return save(e.message, e.uuid);
    });
    return result ?? pendingAppend;
  };

  const $ = {
    clock: { now: async () => now, sleep: async () => {}, after: () => ({ cancel() {} }) },
    env: { get: async () => { await pauseWorld?.(); return undefined; } },
    session: {
      id: async () => "session-a",
      model: async () => "claude-opus-5-5",
      cwd: async () => root,
      append: async ({ message }: { message: any }) => append(message, "note"),
    },
    ui: {
      log: (text: string) => logs.push(text),
      status: (text: string | undefined) => statuses.push(text),
      invalidate: (surface: string) => invalidations.push(surface),
    },
    process: {
      spawn: () => {
        spawns++;
        const stream = (async function* () {
          yield { stream: "stdout", text: JSON.stringify({ socketPath: "/test/private/p" }) + "\n" };
          await new Promise<void>((resolve) => { releaseStream = resolve; });
          return streamEnded;
        })();
        const finish = stream.return.bind(stream);
        stream.return = (value) => { releaseStream?.(); return finish(value); };
        return Object.assign(stream, { result: Promise.resolve(streamEnded) });
      },
      run: async (argv: readonly string[]) => {
        if (argv.includes("--cleanup")) return { exitCode: 0, stdout: "" };
        const task = JSON.parse(argv.at(-1)!);
        if (task.op === "perception") {
          discoveries++;
          await pauseDiscovery?.();
          return { exitCode: 0, stdout: JSON.stringify({ dir: root, path: join(root, task.name, "perception.mjs") }) };
        }
        if (task.op === "list") return { exitCode: 0, stdout: JSON.stringify({ dir: root, names: [...souls.keys()] }), isStdoutTruncated: false };
        if (task.op === "read") {
          const soul = souls.get(task.name);
          return soul
            ? { exitCode: 0, stdout: JSON.stringify({ dir: root, ...soul }), isStdoutTruncated: false }
            : { exitCode: 1, stdout: JSON.stringify({ error: `Soul "${task.name}" not found` }), isStdoutTruncated: false };
        }
        if (task.op === "session") {
          return { exitCode: 0, stdout: JSON.stringify(readClaudeSession(jsonl(), task.headUuid, task.handles, task.sessionId)), isStdoutTruncated: false };
        }
        return { exitCode: 1, stdout: JSON.stringify({ error: "unsupported test task" }), isStdoutTruncated: false };
      },
    },
    http: { fetch: async () => ({ ok: true, text: JSON.stringify({ text: "perception utterance" }) }) },
    prompt: { compose: async () => compose() },
    command: { register: async (spec: any) => { commands.push(spec); return { name: spec.name }; } },
  };

  async function invoke(event: string, eventObject: any, next: (e: any) => any, matcher?: Record<string, unknown>) {
    for (const entry of hooks) {
      if (entry.event !== event) continue;
      if (entry.matcher && !Object.entries(entry.matcher).every(([key, value]) => Array.isArray(value) ? value.includes(eventObject[key]) : eventObject[key] === value)) continue;
      return await entry.hook($, eventObject, next);
    }
    return await next(eventObject);
  }

  const on = ((event: string, matcherOrHook: any, maybeHook?: Hook) => {
    const matcher = typeof matcherOrHook === "object" && matcherOrHook !== null ? matcherOrHook : undefined;
    const hook = (typeof matcherOrHook === "function" ? matcherOrHook : maybeHook) as Hook;
    hooks.push({ event, matcher, hook });
  }) as unknown as On;
  register(on, { timeaware: options.timeaware ?? false, ...(options.defaultSoul ? { defaultSoul: options.defaultSoul } : {}) });

  function sections(lean = false) {
    return [
      { id: lean ? "lean_body" : "intro", text: lean ? "\nYou are a lean native agent.\n\nLean rules.\n" : NATIVE, scope: "shared" as const, cursor: 0 },
      { id: "tools", text: "Tools untouched.", scope: "shared" as const, cursor: 0 },
      { id: "session_guidance", text: GUIDANCE, scope: "session" as const, cursor: 0 },
      { id: "rules", text: "Rules untouched.", scope: "session" as const, cursor: 0 },
    ];
  }

  async function compose(model = "claude-opus-5-5", lean = false): Promise<PromptComposeResult> {
    return await invoke("prompt.compose", {
      model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: lean ? ["lean"] : [],
    }, async () => {
      const result = [];
      for (const section of sections(lean)) {
        const next = await invoke("prompt.section", { name: section.id, text: section.text }, async (e) => ({ text: e.text }));
        sectionResults.push({ name: section.id, text: next.text });
        if (next.text !== null) result.push({ ...section, text: next.text });
      }
      return { sections: result };
    });
  }

  const h = {
    transcript, statuses, invalidations, logs, commands, sectionResults,
    souls,
    pauseWorld(fn?: () => Promise<void>) { pauseWorld = fn; },
    pauseDiscovery(fn?: () => Promise<void>) { pauseDiscovery = fn; },
    discoveries: () => discoveries,
    spawns: () => spawns,
    async tool() { await invoke("classic.PreToolUse", { tool: "Read", path: "/a" }, async () => ({})); },
    async step(index = 1) {
      const hook = hooks.find((entry) => entry.event === "turn.step")!.hook;
      const next = Object.assign(async function* () { return {}; }, { signal: new AbortController().signal });
      for await (const _chunk of hook($, { model: "claude-opus-5-5", index }, next)) {}
    },
    async submit() { await invoke("prompt.submit", { text: "human prompt" }, async (e) => ({ text: e.text })); },
    async end() { await invoke("session.end", {}, async () => ({})); },
    deny(value: string | undefined) { denyNote = value; },
    choice(): SoulChoice | undefined { return lastUuid ? readClaudeSession(jsonl(), lastUuid).choice : undefined; },
    async start(source = "startup") {
      await invoke("classic.SessionStart", {
        hook_event_name: "SessionStart", source, session_id: "session-a", transcript_path: join(root, "transcript.jsonl"),
      }, async (e) => e);
      await invoke("session.start", { cwd: root }, async () => ({ cwd: root }));
    },
    compose,
    async complete(token = "") {
      return invoke("prompt.autocomplete", { text: `/soul ${token}`, start: 6, token }, async () => ({ suggestions: [] }));
    },
    async command(args: string) {
      return await invoke("command.run", { command: "soul", args, origin: { kind: "composer" }, presentation: {} }, async () => ({ text: "" }));
    },
    async echo(args: string, echoed = args) {
      return await append({
        type: "user",
        content: [{ type: "text", text: `<command-name>/soul</command-name><command-message>soul</command-message><command-args>${echoed}</command-args>` }],
      }, "command", { kind: "composer" });
    },
    async assistant(text = "intermediate") {
      return await append({ type: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] }, "response", { kind: "model", model: "claude-opus-5-5" });
    },
    async prompt(text = "next prompt") {
      return await append({ type: "user", content: [{ type: "text", text }] }, "prompt", { kind: "composer" });
    },
    snapshot(parts: string[]) {
      const uuid = `row-${++seq}`;
      const parentUuid = lastUuid ?? null;
      lastUuid = uuid;
      transcript.push({ uuid, parentUuid, timestamp: new Date(now += 1000).toISOString(), isSidechain: false, type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: parts } });
    },
  };
  return h;
}

const choiceRows = (h: ReturnType<typeof host>) => h.transcript.filter((row) => row.type === "system" && row.content.startsWith("Soul choice:"));

test("native opening: only the first paragraph moves, and the slot carries body plus guidance", async () => {
  assert.deepEqual(openingParagraph("\nYou are native.\r\n \r\nREST\r\n"), { body: "You are native.", rest: "\n\r\n \r\nREST\r\n" });
  assert.equal(openingParagraph("Rules first.\n\nYou are later."), undefined);

  const h = host();
  await h.start();
  await h.command("@A");
  await h.echo("@A");
  const composed = await h.compose();
  const intro = composed.sections.find((section) => section.id === "intro")!;
  const guidance = composed.sections.find((section) => section.id === "session_guidance")!;
  assert.equal(intro.text, "\n\n\nIMPORTANT: Keep every native rule.\n");
  assert.equal(guidance.text, "You are soul A.\n\nOriginal session guidance.");
  assert.equal(composed.sections.find((section) => section.id === "tools")!.text, "Tools untouched.");
  assert.equal(composed.sections.find((section) => section.id === "rules")!.text, "Rules untouched.");
  assert.equal(h.sectionResults.findLast((result) => result.name === "session_guidance")!.text, "You are soul A.\n\nOriginal session guidance.");
  assert.equal(h.invalidations.includes("prompt.section"), true);

  const lean = await h.compose("claude-opus-5-5", true);
  assert.equal(lean.sections.find((section) => section.id === "lean_body")!.text, "\n\n\nLean rules.\n");
});

test("native registration and completion expose named souls and controls", async () => {
  const h = host();
  await h.start();
  assert.equal(h.commands[0].name, "soul");
  assert.deepEqual((await h.complete()).suggestions.map((item: any) => item.text), ["@A", "@B", "clear", "reset", "reload"]);
  assert.deepEqual((await h.complete("@B")).suggestions.map((item: any) => item.text), ["@B"]);
});

test("choice commits only after a late, exact kept command echo", async () => {
  const h = host();
  await h.start();
  const requested = await h.command("@A");
  assert.match(requested.text, /Switching to @A for your next message/);
  assert.equal(h.choice(), undefined);

  await h.assistant();
  assert.equal(h.choice(), undefined, "an unrelated row does not consume the pending choice");
  await h.echo("@A");
  assert.deepEqual(h.choice(), { mode: "named", name: "A" });

  const choices = choiceRows(h);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.content, encodeChoice({ mode: "named", name: "A" }));
  const echo = h.transcript.find((row) => row.message?.content?.[0]?.text?.includes("<command-name>/soul</command-name>"));
  assert.equal(choices[0]!.parentUuid, echo.uuid, "the receipt is appended after the kept echo");

  const again = await h.command("@A");
  assert.match(again.text, /@A is already selected/);
  await h.echo("@A");
  assert.equal(choiceRows(h).length, 1);
  assert.deepEqual(h.choice(), { mode: "named", name: "A" });
});

test("denied, invalid, and altered receipts preserve the previous choice", async () => {
  const h = host();
  await h.start();
  await h.command("@A");
  await h.echo("@A");
  assert.deepEqual(h.choice(), { mode: "named", name: "A" });

  await h.command("@B");
  h.deny("receipt refused");
  await h.echo("@B");
  h.deny(undefined);
  assert.deepEqual(h.choice(), { mode: "named", name: "A" });
  assert.equal(choiceRows(h).length, 1);
  assert.ok(h.logs.some((line) => line.includes("receipt refused")));

  const invalid = await h.command("@missing");
  assert.equal(invalid.exitCode, 1);
  await h.echo("@missing");
  assert.deepEqual(h.choice(), { mode: "named", name: "A" });

  await h.command("@B");
  await h.echo("@B", "@A");
  assert.deepEqual(h.choice(), { mode: "named", name: "A" }, "a changed native echo is not a receipt");
  assert.equal(choiceRows(h).length, 1);
});

test("snapshot-backed status confirms only a matching recorded prompt", async () => {
  const h = host();
  await h.start();
  const unconfirmed = await h.command("");
  assert.match(unconfirmed.text, /Active: unconfirmed/);
  assert.equal(h.statuses.at(-1), undefined);

  await h.command("@A");
  await h.echo("@A");
  const before = (await h.compose()).sections.filter((section) => section.text !== "").map((section) => section.text);
  h.snapshot(before);
  await h.prompt("after the snapshot");
  const confirmed = await h.command("");
  assert.match(confirmed.text, /Active: A/);
  assert.equal(h.statuses.at(-1), "✦");
});

test("slow world/discovery cannot start an old identity's runtime after a kept switch", async () => {
  for (const boundary of ["world", "discovery"] as const) {
    const h = host();
    await h.start();
    await h.command("@A"); await h.echo("@A");
    h.snapshot((await h.compose()).sections.filter((section) => section.text !== "").map((section) => section.text));
    await h.prompt(); await h.command("");
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const pause = async () => { entered(); await blocked; };
    if (boundary === "world") h.pauseWorld(pause); else h.pauseDiscovery(pause);
    const pending = h.tool();
    await waiting;
    await h.command("@B"); await h.echo("@B");
    release();
    await pending;
    assert.equal(h.spawns(), 0, `${boundary} invalidation stops the call before child startup`);
    if (boundary === "world") assert.equal(h.discoveries(), 0);
    await h.end();
  }
});

test("tool utterances wait for the safe boundary and a kept switch/reload drops queued generations", async () => {
  for (const change of ["switch", "reload", "none"] as const) {
    const h = host();
    await h.start();
    await h.command("@A"); await h.echo("@A");
    h.snapshot((await h.compose()).sections.filter((section) => section.text !== "").map((section) => section.text));
    await h.prompt(); await h.command("");
    try {
      await h.step(); // Deliver startup wake before measuring tool-only notes.
      const notes = () => h.transcript.filter((row) => row.message?.content?.some((block: any) => block.text?.includes("perception utterance")));
      const baseline = notes().length;
      await h.tool();
      assert.equal(notes().length, baseline, "tool hook does not append between a call and its result");
      if (change === "switch") { await h.command("@B"); await h.echo("@B"); }
      if (change === "reload") await h.command("reload");
      await h.step();
      assert.equal(notes().length - baseline, change === "none" ? 1 : 0);
    } finally { await h.end(); }
  }
});

test("clear during a wake await suppresses the old turn's clock and human perception", async () => {
  const h = host({ timeaware: true });
  await h.start();
  await h.command("@A"); await h.echo("@A");
  h.snapshot((await h.compose()).sections.filter((section) => section.text !== "").map((section) => section.text));
  await h.prompt(); await h.command("");
  await h.submit(); await h.prompt("human prompt");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  h.pauseDiscovery(async () => { entered(); await blocked; });
  const pending = h.step(0);
  await waiting;
  await h.command("clear"); await h.echo("clear");
  release();
  await pending;
  assert.equal(h.spawns(), 0);
  assert.equal(h.discoveries(), 1, "the pending human event is not redispatched after the switch");
  assert.ok(!h.transcript.some((row) => row.message?.content?.some((block: any) => /⌚|perception utterance/.test(block.text ?? ""))));
  await h.end();
});

const message = (handle: string, role: "user" | "assistant", extra: Partial<SessionMessage> = {}): SessionMessage => ({
  handle, role, text: "", toolUses: [], ...extra,
});
const use = (id: string) => ({ tool_use_id: id, tool: "Read", input: {} });
const result = (id: string) => ({ tool_use_id: id, text: id, isError: false });

test("retainedMessages restores a tool-result batch in original order, before the new tail", () => {
  const before = [
    message("summary", "assistant", { text: "native summary" }),
    message("u1", "user", { text: "old question" }),
    message("a1", "assistant", { toolUses: [use("t1"), use("t2")] }),
    message("r1", "user", { toolResults: [result("t1")] }),
    message("r2", "user", { toolResults: [result("t2")] }),
    message("a2", "assistant", { text: "old answer" }),
    message("u2", "user", { text: "old tail" }),
  ];
  const after = [
    before[0]!,
    message("n1", "user", { text: "new question" }),
    message("n2", "assistant", { text: "new answer" }),
  ];

  const fromResult = retainedMessages(before, after, ["r1"]);
  assert.deepEqual(fromResult.map((item) => item.handle), ["summary", "a1", "r1", "r2", "n1", "n2"]);
  assert.ok(!fromResult.some((item) => ["u1", "a2", "u2"].includes(item.handle!)));

  const fromAssistant = retainedMessages(before, after, ["a1"]);
  assert.deepEqual(fromAssistant.map((item) => item.handle), ["summary", "a1", "r1", "r2", "n1", "n2"]);
});
