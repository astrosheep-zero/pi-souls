import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWireHost, type WireHost, type WireTurn } from "./claude-wire-host.ts";
import { readClaudeSession } from "../src/claude-session.ts";

const A = "WIRE_SOUL_A", B = "WIRE_SOUL_B", EDIT = "WIRE_SOUL_B_EDIT";
const souls = { a: A, b: B };
const settings = (options: Record<string, unknown> = {}) => ["--settings", JSON.stringify({ pluginConfigs: { "pi-souls@inline": { options: { defaultSoul: "a", ...options } } } })];
const system = (turn: WireTurn) => turn.apiBodies.at(-1)?.system.map((block: any) => block.text).join("\n\n") ?? "";
const text = (row: any): string => typeof row.message?.content === "string" ? row.message.content : (row.message?.content ?? []).map((b: any) => b.text ?? "").join("\n");
const clearWarnings = (host: WireHost) => host.events.filter((event) => event.type === "system" && event.subtype === "ui_log" && String(event.text).includes("Clear was recorded, but Claude’s current prompt still uses"));
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
test("native commands change the next wire prompt, reload fresh content, and never run a model", { timeout: 120_000 }, async () => {
  const host = await createWireHost({ souls, args: settings(), debug: true });
  try {
    await command(host, "/soul clear");
    await human(host, "initially disabled", null);
    await command(host, "/soul");
    assert.equal(clearWarnings(host).length, 0, "normal clear and status do not warn from old snapshots");
    await command(host, "/soul @a");
    const first = await human(host, "select A", A);
    const prefix = JSON.stringify(first.apiBodies[0]);
    assert.ok(!JSON.stringify(first.apiBodies[0].messages).includes("new soul: a"), "turn.step notes are future-only");
    await human(host, "observe delivered cue", A);
    assert.equal(JSON.stringify(first.apiBodies[0]), prefix, "sent requests are never rewritten");
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
    assert.equal(rows.filter((r) => r.isMeta && text(r).includes("⌚")).length, 1, "delivered clock baseline is not duplicated");
    assert.ok(!host.apiBodies.some((body) => body.messages.some((message: any) => {
      const content = typeof message.content === "string" ? [message.content] : message.content.map((block: any) => block.type === "text" ? block.text : "");
      return content.some((part: string) => /^Soul choice: (?:@\S+|disabled|defaults)$/.test(part));
    })), "system selection receipts never enter model context as messages");
  } finally { await host.stop(); }
});

test("observe compact-fork clear defect and reset recovery while checking native branch persistence", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-souls-lifecycle-"));
  const options = { dir, souls, args: settings(), debug: true };
  let host = await createWireHost(options);
  try {
    await human(host, "first default", A);
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
    const clock = old.rows.find((r) => r.isMeta && text(r).includes("⌚"));
    assert.ok(clock);
    const compact = await host.send("/compact");
    assert.equal(compact.result.is_error, false);
    await human(host, "after compaction", B);
    const parent = host.sessionId;
    await host.stop();
    host = await createWireHost({ ...options, resume: parent });
    await human(host, "resumed parent", B);
    assert.deepEqual((await session(host)).state.choice, { mode: "named", name: "b" });
    await host.stop();
    host = await createWireHost({ ...options, resume: parent, forkSession: true });
    await human(host, "inherited compact fork", B);
    await command(host, "/soul clear");
    await command(host, "/soul");
    assert.equal(clearWarnings(host).length, 0, "clear/status must not warn before a model request proves the mismatch");
    const frozenTurn = await human(host, "fork clear keeps inherited host snapshot", B);
    assert.equal(clearWarnings(host).length, 1);
    assert.match(String(clearWarnings(host)[0].text), /still uses @b.*new session.*\/soul reset/);
    assert.ok(!JSON.stringify(frozenTurn.apiBodies).includes("Clear was recorded"), "warning is human-only");
    await human(host, "same frozen prompt again", B);
    assert.equal(clearWarnings(host).length, 1, "the existing warning dedup prevents repeated logs");
    assert.deepEqual((await session(host)).state.choice, { mode: "disabled" }, "clear receipt is durable even while host snapshot is frozen");
    const frozen = await command(host, "/soul");
    assert.match(frozen, /Active: b/);
    assert.match(frozen, /Configured: none/);
    await command(host, "/soul reset");
    await human(host, "fork follows defaults", A);
    assert.equal(clearWarnings(host).length, 1, "reset recovery produces no new mismatch warning");
    await command(host, "/soul @b");
    await human(host, "fork can still select", B);
    const child = await session(host);
    assert.deepEqual(child.state.choice, { mode: "named", name: "b" });
    const clocks = child.rows.filter((r) => r.isMeta && text(r).includes("⌚"));
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
    assert.equal((await session(host)).rows.filter((r) => r.isMeta && /new soul:|⌚/.test(text(r))).length, 0);
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
    for (let retry = 0; switched.response.subtype === "error" && /turn.running|running turn|while.*running|in progress/i.test(JSON.stringify(switched.response)) && retry < 5; retry++) {
      await wait();
      switched = await host.control({ subtype: "set_model", model: "claude-sonnet-5-5" });
    }
    assert.equal(switched.response.subtype, "success", JSON.stringify(switched.response));
    await human(host, "mapped resolved model", B);
    await human(host, "brain cue arrives later", B);
    await human(host, "backend alias cannot retrigger it", B);
    const { rows } = await session(host);
    const brains = rows.filter((r) => r.isMeta && text(r).includes("new brain:"));
    assert.equal(brains.length, 1);
    assert.ok(text(brains[0]).includes("new brain: claude-sonnet-5-5"));
  } finally { await host.stop(); }
});
