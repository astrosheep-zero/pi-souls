import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWireHost, ownPluginNote, wireNoteLines, type WireHost, type WireMessage, type WireTurn } from "./claude-wire-host.ts";
import { readClaudeSession } from "../src/claude-session.ts";
import { unwrapReminder, wrapReminder } from "../src/utterance.ts";

const A = "WIRE_SOUL_A", B = "WIRE_SOUL_B", EDIT = "WIRE_SOUL_B_EDIT";
const souls = { a: A, b: B };
const settings = (options: Record<string, unknown> = {}) => ["--settings", JSON.stringify({ pluginConfigs: { "pi-souls@inline": { options: { defaultSoul: "a", ...options } } } })];
const system = (turn: WireTurn) => turn.apiBodies.at(-1)?.system.map((block: any) => block.text).join("\n\n") ?? "";
const text = (row: any): string => typeof row.message?.content === "string" ? row.message.content : (row.message?.content ?? []).map((b: any) => b.text ?? "").join("\n");
const clockAttachments = (rows: any[]) => rows.filter((row) => row.type === "attachment"
  && row.attachment?.type === "hook_additional_context" && row.attachment.hookName === "prompt.submit"
  && row.attachment.content.some((part: string) => part.includes("⌚ ")));
const clearWarnings = (host: WireHost) => host.events.filter((event) => event.type === "system" && event.subtype === "ui_log" && String(event.text).includes("turning off souls did not take effect"));
const wait = () => new Promise((resolve) => setTimeout(resolve, 400));
async function command(host: WireHost, input: string) {
  const turn = await host.send(input);
  assert.equal(turn.apiBodies.length, 0, `native ${input} must not make a model request`);
  return String(turn.result.result ?? "");
}
async function human(host: WireHost, input: string, expected: string | null) {
  const turn = await host.send(input);
  assert.equal(turn.result.is_error, false, host.stderr());
  const sent = system(turn);
  if (expected) assert.ok(sent.includes(expected), `missing ${expected} in actual system prompt`);
  else {
    assert.ok(!sent.includes("WIRE_SOUL_"));
    assert.ok(sent.includes("You are an agent working with the user"));
  }
  assert.ok(sent.includes("# Harness"), "unrelated native instructions survive");
  return turn;
}
async function session(host: WireHost) {
  await wait();
  const rows = await host.transcript();
  assert.ok(rows?.length && host.transcriptPath);
  const head = rows.findLast((row) => row.uuid && ["user", "assistant", "system", "attachment"].includes(row.type));
  assert.ok(head);
  return { rows, state: readClaudeSession(readFileSync(host.transcriptPath, "utf8"), head.uuid) };
}

// Real host only, loopback API only; snapshots remain at their native default.
test("adjacent pronouns slot restores the exact native wire system on clear", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-souls-native-wire-"));
  const nativePlugin = join(dir, "native-plugin");
  mkdirSync(join(nativePlugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(nativePlugin, "hooks"));
  writeFileSync(join(nativePlugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "wire-native", version: "0.0.1" }));
  writeFileSync(join(nativePlugin, "hooks/hooks.json"), "{}");
  const options = { home: join(dir, "home"), configDir: join(dir, "config"), cwd: join(dir, "work"), model: "claude-sonnet-5-5" };
  const wire = (turn: WireTurn) => turn.apiBodies.at(-1)?.system;
  let host = await createWireHost({ ...options, dir: join(dir, "stock"), pluginDir: nativePlugin });
  try {
    const nativeFirst = wire(await host.send("first request"));
    const nativeSecond = wire(await host.send("second request"));
    assert.ok(nativeFirst && nativeSecond);
    await host.stop();
    host = await createWireHost({ ...options, dir: join(dir, "souls"), souls, args: settings({ timeaware: false }) });
    const active = wire(await human(host, "first request", A));
    const opening = "You are an agent working with the user toward their goals, using your own judgment along the way.";
    assert.deepEqual(active, nativeFirst.map((block: any) => ({ ...block, text: block.text.replace(opening, A) })));
    await command(host, "/soul clear");
    assert.deepEqual(wire(await human(host, "second request", null)), nativeSecond);
  } finally { await host.stop(); }
});

test("native commands change the next wire prompt, reload fresh content, and never run a model", { timeout: 120_000 }, async () => {
  const host = await createWireHost({ souls, args: settings(), debug: true });
  try {
    await command(host, "/soul clear");
    await human(host, "initially disabled", null);
    await command(host, "/soul");
    assert.equal(clearWarnings(host).length, 0, "normal clear and status do not warn from old snapshots");
    await command(host, "/soul @a");
    const first = await human(host, "select A", A);
    const firstBody = structuredClone(first.apiBodies[0]);
    assert.ok(!(firstBody.messages as WireMessage[]).some((message) => wireNoteLines(message).includes("new soul: a")), "turn.step notes are future-only");
    await human(host, "observe delivered cue", A);
    assert.deepEqual(first.apiBodies[0], firstBody, "sent requests are never rewritten");
    let before = await session(host);
    await command(host, "/soul @a");
    await human(host, "no-op", A);
    const after = await session(host);
    assert.equal(after.rows.filter((r) => r.content === "Soul choice: @a").length, before.rows.filter((r) => r.content === "Soul choice: @a").length);
    await command(host, "/soul @b");
    await human(host, "switch B", B);
    const dividers = (await session(host)).rows.filter((r) => r.content === "── soul: b ──").length;
    host.writeSoul("b", EDIT);
    await command(host, "/soul reload");
    await human(host, "edited body", EDIT);
    assert.equal((await session(host)).rows.filter((r) => r.content === "── soul: b ──").length, dividers, "body edit is not an identity transition");
    host.writeSoul("b", "{% include 'parts/missing' %}");
    assert.match(await command(host, "/soul reload"), /Soul:/);
    assert.match(await command(host, "/soul @missing"), /Soul:/);
    assert.equal((await session(host)).state.choice?.mode, "named", "failed commands preserve the choice");
    host.writeSoul("b", EDIT);
    await human(host, "recover body", EDIT);
    await command(host, "/soul clear");
    await human(host, "native identity again", null);
    await command(host, "/soul reset");
    await human(host, "configured default again", A);
    const { rows, state } = await session(host);
    assert.deepEqual(state.choice, { mode: "defaults" });
    assert.equal(clockAttachments(rows).length, 1, "delivered clock baseline is not duplicated");
    assert.ok(!host.apiBodies.some((body) => body.messages.some((message: any) => {
      const content = typeof message.content === "string" ? [message.content] : message.content.map((block: any) => block.type === "text" ? block.text : "");
      return content.some((part: string) => /^Soul choice: (?:@\S+|disabled|defaults)$/.test(part));
    })), "system selection receipts never enter model context as messages");
  } finally { await host.stop(); }
});

test("folded opening follows native rewind, resume, compact and fork", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-souls-lifecycle-"));
  const options = { dir, souls, args: settings(), debug: true };
  let host = await createWireHost(options);
  try {
    const first = await human(host, "first default", A);
    const seen = first.apiBodies[0]!.messages.flatMap((m: any) => m.role === "user"
      ? typeof m.content === "string" ? [m.content] : m.content.map((b: any) => b.text) : []);
    assert.ok(seen.includes("first default"), "user text reaches Claude unchanged");
    assert.ok(seen.some((part: unknown) => typeof part === "string" && part.includes("⌚ ")), "clock is in the first main request");
    await command(host, "/soul @b");
    await human(host, "branch B", B);
    await command(host, "/soul @a");
    await wait();
    const rows = await host.transcript();
    const echo = rows?.findLast((r) => r.type === "user" && text(r).includes("<command-args>@a</command-args>"));
    assert.ok(echo);
    const rewind = await host.control({ subtype: "rewind_conversation", target_message_uuid: echo.uuid });
    assert.equal(rewind.response.response.rewound, true, "the business rewind result, not only transport success");
    await human(host, "FIRST wire after rewind", B);
    const old = await session(host);
    const clocksBefore = clockAttachments(old.rows);
    assert.equal(clocksBefore.length, 1, "within-hour submits do not attach a second clock");
    const clock = clocksBefore[0]!;
    assert.equal(old.state.noteAt, Date.parse(clock.timestamp));
    assert.ok(old.rows.some((r) => r.type === "user" && !r.isMeta && text(r) === "first default"));
    assert.ok(!old.rows.some((r) => r.type === "user" && r.isMeta && text(r).includes("⌚ ")), "no late clock meta user row");
    const compact = await host.send("/compact");
    assert.equal(compact.result.is_error, false);
    await human(host, "after compaction", B);
    assert.equal((await session(host)).state.noteAt, Date.parse(clock.timestamp), "compaction keeps the original clock baseline");
    const parent = host.sessionId;
    await host.stop();
    host = await createWireHost({ ...options, resume: parent });
    await human(host, "resumed parent", B);
    const resumed = await session(host);
    assert.deepEqual(resumed.state.choice, { mode: "named", name: "b" });
    assert.equal(resumed.state.noteAt, Date.parse(clock.timestamp), "resume does not refresh the clock early");
    await host.stop();
    host = await createWireHost({ ...options, resume: parent, forkSession: true });
    await human(host, "inherited compact fork", B);
    await command(host, "/soul clear");
    await command(host, "/soul");
    assert.equal(clearWarnings(host).length, 0, "clear/status must not warn before a model request proves the mismatch");
    await human(host, "fork clear restores native opening", null);
    assert.equal(clearWarnings(host).length, 0);
    assert.deepEqual((await session(host)).state.choice, { mode: "disabled" });
    assert.match(await command(host, "/soul"), /Active: none/);
    await command(host, "/soul reset");
    await human(host, "fork follows defaults", A);
    await command(host, "/soul @b");
    await human(host, "fork can still select", B);
    const child = await session(host);
    assert.deepEqual(child.state.choice, { mode: "named", name: "b" });
    const clocks = clockAttachments(child.rows);
    assert.equal(clocks.length, 1);
    assert.equal(clocks[0].timestamp, clock.timestamp, "native carrier keeps original timestamp, never backdates a duplicate");
  } finally { await host.stop(); }
});

test("explicit custom and legacy snapshots suppress unproven identity; compact migrates legacy", { timeout: 120_000 }, async () => {
  let host = await createWireHost({ souls, args: [...settings(), "--system-prompt", "WIRE_CUSTOM_NATIVE"] });
  try {
    let turn = await host.send("custom start");
    assert.ok(system(turn).includes("WIRE_CUSTOM_NATIVE"));
    await command(host, "/soul @b");
    turn = await host.send("custom stays custom");
    assert.ok(system(turn).includes("WIRE_CUSTOM_NATIVE"));
    assert.ok(!system(turn).includes(B));
    assert.match(await command(host, "/soul"), /Active: unconfirmed/);
    // Detached preview may still propose a soul. That permits submit context,
    // not a proven identity or a late meta reminder.
    const { rows } = await session(host);
    const delivered = rows.flatMap((row) => ownPluginNote(row)?.delivered ?? []).map(unwrapReminder);
    assert.ok(!delivered.some((part) => part.startsWith("new soul: ") || part.startsWith("⌚ ")));
  } finally { await host.stop(); }

  const dir = mkdtempSync(join(tmpdir(), "pi-souls-legacy-")), legacy = join(dir, "legacy-plugin");
  cpSync(join(import.meta.dirname, "../plugins/claude"), legacy, { recursive: true });
  writeFileSync(join(legacy, "hooks/register.js"), `export function register(on) { on("prompt.compose", async ($,e,next) => { const r=await next(e); return {...r, sections:r.sections.map(s => s.id === "intro" || s.id === "lean_body" ? {...s,text:s.text.replace(/^\\s*You are[^\\n]*(?:\\n(?!\\n)[^\\n]*)*/,"WIRE_LEGACY_SOUL")} : s)}; }); }`);
  host = await createWireHost({ dir, souls, args: settings(), pluginDir: legacy });
  try {
    assert.ok(system(await host.send("legacy start")).includes("WIRE_LEGACY_SOUL"));
    const id = host.sessionId;
    await host.stop();
    host = await createWireHost({ dir, souls, args: settings(), resume: id });
    await host.send("resume legacy");
    await command(host, "/soul @b");
    const turn = await host.send("legacy remains frozen");
    assert.ok(system(turn).includes("WIRE_LEGACY_SOUL"));
    assert.ok(!system(turn).includes(B));
    assert.match(await command(host, "/soul"), /Active: unconfirmed/);
    await host.send("/compact");
    await human(host, "migrated layout", B);
  } finally { await host.stop(); }
});

test("denied choice is transactional; a denied soul cue does not consume the durable transition", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-souls-denial-")), policy = join(dir, "policy");
  mkdirSync(join(policy, ".claude-plugin"), { recursive: true });
  mkdirSync(join(policy, "hooks"));
  writeFileSync(join(policy, ".claude-plugin/plugin.json"), JSON.stringify({ name: "wire-policy", version: "1.0.0", description: "Local wire-test append refusal" }));
  writeFileSync(join(policy, "hooks/hooks.json"), JSON.stringify({ hooks: {}, modules: ["./policy.js"] }));
  writeFileSync(join(policy, "hooks/policy.js"), `export function register(on) {
    on("session.append", {door:"note"}, async ($,e,next) => {
      const text=e.message.content.map(b => b.type === "text" ? b.text : "").join("");
      const deny=await $.env.get("WIRE_DENY");
      if ((deny === "choice" && text === "Soul choice: @b") || (deny === "cue" && text.includes("new soul: b"))) return {deny:"wire-policy denial"};
      return next(e);
    });
  }`);
  const options = { dir, souls, args: [...settings(), "--plugin-dir", policy], debug: true };
  let host = await createWireHost({ ...options, env: { WIRE_DENY: "choice" } });
  try {
    await human(host, "initial A", A);
    await command(host, "/soul @b");
    await human(host, "denied selection stays A", A);
    assert.equal((await session(host)).rows.filter((r) => r.content === "Soul choice: @b").length, 0);
    const id = host.sessionId;
    await host.stop();
    host = await createWireHost({ ...options, resume: id, env: { WIRE_DENY: "cue" } });
    await human(host, "resume A", A);
    await command(host, "/soul @b");
    await human(host, "B body with refused cue", B);
    const refused = await session(host);
    assert.deepEqual(refused.state.choice, { mode: "named", name: "b" });
    assert.equal(refused.state.soul, "a", "denial leaves prior delivered transition baseline");
    assert.equal(refused.rows.filter((r) => r.content === "── soul: b ──").length, 0);
    await host.stop();
    host = await createWireHost({ ...options, resume: id, env: { WIRE_DENY: "" } });
    await human(host, "resume with cue allowed", B);
    await human(host, "confirm restored slot", B);
    const retried = await session(host);
    assert.equal(retried.state.soul, "b");
    assert.equal(retried.rows.filter((r) => r.content === "── soul: b ──").length, 1);
  } finally { await host.stop(); }
});

test("explicit session choice beats SOULLESS; resolved model switches drive mappings and one brain cue", { timeout: 120_000 }, async () => {
  let host = await createWireHost({ souls, args: settings(), env: { SOULLESS: "true" } });
  try {
    await human(host, "SOULLESS defaults", null);
    await command(host, "/soul @a");
    await human(host, "explicit choice still wins", A);
    await command(host, "/soul reset");
    await human(host, "reset respects SOULLESS", null);
  } finally { await host.stop(); }

  host = await createWireHost({ souls, args: settings({ modelSouls: ["claude-sonnet-5-5=b"] }), response: { content: [{ type: "text", text: "mock reply" }], model: "backend-wire-alias" } });
  try {
    await human(host, "before model switch", A);
    await wait();
    let switched = await host.control({ subtype: "set_model", model: "claude-sonnet-5-5" });
    // A result event may precede the host's idle transition. Retry only its
    // explicit turn-running refusal; never treat a refused switch as success.
    for (let retry = 0; switched.response.subtype === "error" && typeof switched.response.error === "string"
      && /turn.running|running turn|while.*running|in progress/i.test(switched.response.error) && retry < 5; retry++) {
      await wait();
      switched = await host.control({ subtype: "set_model", model: "claude-sonnet-5-5" });
    }
    assert.equal(switched.response.subtype, "success", switched.response.error);
    await human(host, "mapped resolved model", B);
    const cue = "new brain: claude-sonnet-5-5";
    const isBrain = (part: string) => part.startsWith("new brain: ");
    for (const input of ["brain cue arrives later", "backend alias cannot retrigger it"]) {
      const turn = await human(host, input, B);
      const messages: WireMessage[] = turn.apiBodies.at(-1)!.messages;
      const visible = messages.flatMap((message) => wireNoteLines(message).filter(isBrain).map((line) => [message.role, line]));
      assert.deepEqual(visible, [["user", cue]]);
    }
    const { rows } = await session(host);
    const brains = rows.flatMap((row) => ownPluginNote(row)?.delivered ?? []).filter((part) => isBrain(unwrapReminder(part)));
    assert.deepEqual(brains, [wrapReminder(cue)]);
  } finally { await host.stop(); }
});
