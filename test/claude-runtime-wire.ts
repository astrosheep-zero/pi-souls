import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createWireHost } from "./claude-wire-host.ts";

// Actual Claude parser + process.spawn/http APIs, with loopback model responses.
// In particular, a CPU-bound module must not survive the bounded request timeout.
const dir = mkdtempSync(join(tmpdir(), "perception-cpu-wire-"));
const plugin = join(dir, "probe");
const hooks = join(plugin, "hooks");
mkdirSync(hooks, { recursive: true });
mkdirSync(join(plugin, ".claude-plugin"));
writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "runtime-probe", version: "1.0.0" }));
writeFileSync(join(hooks, "hooks.json"), JSON.stringify({ modules: ["./register.js"] }));
for (const file of ["perception-runtime.mjs", "perception-import.mjs", "perception-runtime.LICENSE"]) {
  copyFileSync(join(import.meta.dirname, "..", "plugins", "claude", "hooks", file), join(hooks, file));
}
const receipt = join(dir, "receipt.json");
const pidFile = join(dir, "pid.json");
const path = join(dir, "perception.mjs");
writeFileSync(path, `import {writeFileSync} from 'node:fs'; let count=0;
export function perception(moment) {
  writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid}));
  if(moment.text==='cpu timeout') while(true){}
  return {kind:'remind',text:'counter:'+ ++count};
}`);
const source = `
import {createPerceptionRuntime,runPerception,stopRuntime} from './plugins/claude/hooks/perception-runtime.ts';
const state=createPerceptionRuntime(); const records=[];
export function register(on) {
  on('prompt.submit',async($,e,next)=>{
    const start=await $.clock.now();
    const task={path:${JSON.stringify(path)},moment:{kind:'human',text:e.text},world:{sessionId:await $.session.id(),now:start,cwd:await $.session.cwd(),storeDir:${JSON.stringify(dir)},facts:{}}};
    const pending=runPerception($,state,task,next.signal);
    const child=state.child;
    if(child) await child.ready;
    const said=await pending;
    records.push({complete:true,elapsed:(await $.clock.now())-start,said:said??null,pid:JSON.parse(await $.fs.read(${JSON.stringify(pidFile)})).pid,socket:child?.socket});
    await $.fs.write(${JSON.stringify(receipt)},JSON.stringify(records));
    return next(e);
  });
  on('session.end',async($,e,next)=>{await stopRuntime($,state);return next(e);});
}`;
await build({
  stdin: { contents: source, resolveDir: join(import.meta.dirname, ".."), sourcefile: "runtime-wire-probe.ts" },
  outfile: join(hooks, "register.js"), bundle: true, platform: "neutral", format: "esm", target: "es2023",
});
const host = await createWireHost({ pluginDir: plugin, timeoutMs: 35_000, debug: true });
let records: { elapsed: number; said: unknown; pid: number; socket: string }[] = [];
try {
  await host.send("cpu timeout");
  assert.ok(existsSync(receipt), `Actual host loaded the bridge: ${host.stderr()}`);
  records = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(records[0]!.said, null);
  assert.ok(records[0]!.elapsed < 20_000, "CPU timeout completes boundedly");
  assert.equal(existsSync(dirname(records[0]!.socket)), false);
  const ps = spawnSync("ps", ["-p", String(records[0]!.pid), "-o", "stat=,%cpu=,command="], { encoding: "utf8" });
  assert.equal(ps.status, 1, `Default TERM kills CPU child; post-stream cleanup removes socket: ${ps.stdout}`);
  await host.send("normal");
  await host.send("normal again");
  records = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(records.slice(1).map((record) => record.said), [{ kind: "remind", text: "counter:1" }, { kind: "remind", text: "counter:2" }]);
  assert.notEqual(records[0]!.pid, records[1]!.pid);
  assert.equal(records[1]!.pid, records[2]!.pid);
  await host.stop();
  assert.equal(existsSync(dirname(records[2]!.socket)), false, "ordinary session end cleans its private socket");
  assert.equal(spawnSync("ps", ["-p", String(records[2]!.pid), "-o", "stat="], { encoding: "utf8" }).status, 1);
  console.log("Real Claude runtime wire: default TERM killed CPU child, cleaned socket, restarted, retained state, and session end cleaned up.");
} finally {
  await host.stop();
  for (const record of records) {
    if (existsSync(dirname(record.socket))) rmSync(dirname(record.socket), { recursive: true, force: true });
  }
  // Keep a failed probe from leaving an infinite loop on the development host.
  if (existsSync(pidFile)) {
    const { pid } = JSON.parse(readFileSync(pidFile, "utf8"));
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (ps.stdout.includes(join(host.pluginDir, "hooks", "perception-runtime.mjs"))) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// Also exercise the shipped adapter: evidenced identity, retained per-soul state,
// native reload, and future-request delivery (not merely the isolated bridge).
const live = await createWireHost({
  souls: { a: "RUNTIME_SOUL_A", b: "RUNTIME_SOUL_B" },
  args: ["--settings", JSON.stringify({ pluginConfigs: { "pi-souls@inline": { options: { defaultSoul: "a", timeaware: false } } } })],
  debug: true,
});
const trace = join(live.dir, "perceptions.jsonl");
const soulDir = join(live.home, ".agents", "souls");
const writePerception = (name: string, label: string) => {
  mkdirSync(join(soulDir, name), { recursive: true });
  writeFileSync(join(soulDir, name, "SOUL.md"), `RUNTIME_SOUL_${name.toUpperCase()}`);
  writeFileSync(join(soulDir, name, "perception.ts"), `import {appendFileSync} from 'node:fs';
    enum Unit { One = 1 } namespace Label { export const text = ${JSON.stringify(label)}; }
    class Counter { constructor(public n: number) {} } const counter = new Counter(0);
    export function perception(moment) { counter.n += Unit.One;
      const row={label:Label.text,n:counter.n,pid:process.pid,kind:moment.kind};
      appendFileSync(${JSON.stringify(trace)},JSON.stringify(row)+'\\n');
      if (moment.kind === 'human' && moment.text === 'ignore this ephemeral') return {kind:'ephemeral',text:'IGNORED_EPHEMERAL'};
      return {kind:'remind',text:'RUNTIME_CALL:'+Label.text+':'+counter.n}; }`);
};
const rows = (): { label: string; n: number; pid: number; kind: string }[] =>
  existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
try {
  writePerception("a", "A"); writePerception("b", "B");
  await live.send("first A"); await live.send("second A"); await live.send("third A");
  let a = rows().filter((row) => row.label === "A");
  assert.ok(a.length >= 2, `Shipped adapter actually executes perceptions: ${live.stderr()}`);
  assert.deepEqual(a.map((row) => row.n), a.map((_, index) => index + 1));
  assert.equal(new Set(a.map((row) => row.pid)).size, 1);
  const visible = JSON.stringify(live.apiBodies.map((body) => body.messages));
  assert.ok(visible.includes("RUNTIME_CALL:A:"), "perception enters a future actual request");
  const ephemeralTurn = await live.send("ignore this ephemeral");
  assert.equal(ephemeralTurn.apiBodies.length, 1);
  assert.equal(rows().at(-1)?.kind, "human", "Claude ran the ephemeral perception");
  const nextTurn = await live.send("after ignored ephemeral");
  assert.doesNotMatch(JSON.stringify([...ephemeralTurn.apiBodies, ...nextTurn.apiBodies]), /IGNORED_EPHEMERAL/);
  const transcript = await live.transcript();
  assert.ok(transcript?.length);
  assert.doesNotMatch(JSON.stringify(transcript), /IGNORED_EPHEMERAL/);
  a = rows().filter((row) => row.label === "A");
  const beforeSwitch = a.at(-1)!.n;
  await live.send("/soul @b"); await live.send("use B"); await live.send("observe B");
  assert.equal(rows().find((row) => row.label === "B")?.n, 1);
  await live.send("/soul @a"); await live.send("back to A"); await live.send("observe A again");
  a = rows().filter((row) => row.label === "A");
  assert.ok(a.at(-1)!.n > beforeSwitch);
  assert.equal(new Set(rows().map((row) => row.pid)).size, 1, "switches retain one session child");
  writePerception("a", "EDITED");
  const reload = await live.send("/soul reload");
  assert.equal(reload.apiBodies.length, 0);
  await live.send("after reload"); await live.send("observe reload");
  assert.equal(rows().find((row) => row.label === "EDITED")?.n, 1);
  assert.equal(new Set(rows().map((row) => row.pid)).size, 1, "reload evicts the entry, not the process");
  console.log("Real shipped Claude adapter: shared full TS, per-soul memory, native reload, future-request utterances passed.");
} finally { await live.stop(); }
