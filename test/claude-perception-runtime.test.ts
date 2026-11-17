/// <reference path="../plugins/claude/types/claude-code.d.ts" />
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from "claude-code";
import { loadPerception } from "../src/perception.ts";

const root = mkdtempSync(join(tmpdir(), "claude-runtime #% "));
const hooks = join(root, "plugin", "hooks");
cpSync(join(import.meta.dirname, "..", "plugins", "claude"), join(root, "plugin"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

async function start() {
  const child = spawn(process.execPath, [join(hooks, "perception-runtime.mjs")], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_PATH: "" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  const ready = await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(10_000) }).then(([line]) => JSON.parse(line).socketPath as string),
    exited.then(() => { throw new Error(`Runtime exited before readiness: ${stderr}`); }),
  ]);
  lines.close();
  child.stdout.resume();
  return {
    child, socketPath: ready,
    call: (operation: "perceive" | "reload", payload: unknown) => new Promise<any>((resolve, reject) => {
      const req = request({ socketPath: ready, path: `/${operation}`, method: "POST" }, (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => {
          try { assert.equal(response.statusCode, 200, text); resolve(JSON.parse(text)); } catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("Runtime request timeout")));
      req.end(JSON.stringify(payload));
    }),
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
      const cleanup = spawnSync(process.execPath, [join(hooks, "perception-runtime.mjs"), "--cleanup", ready]);
      assert.equal(cleanup.status, 0);
      assert.equal(existsSync(dirname(ready)), false, stderr);
    },
  };
}

const world = { now: 1, sessionId: "session-a", cwd: root, storeDir: root, facts: {} };
const moment = { kind: "human", text: "hello" };

test("standalone shared loader retains full TS state and reloads only the active entry", async () => {
  for (let parent = root; ; parent = dirname(parent)) {
    assert.equal(existsSync(join(parent, "node_modules")), false);
    if (dirname(parent) === parent) break;
  }
  const dir = join(root, "typescript");
  const piDir = join(root, "pi-typescript");
  mkdirSync(dir);
  mkdirSync(piDir);
  const path = join(dir, "perception.ts");
  const piPath = join(piDir, "perception.ts");
  const source = (label: string) => `
import {suffix} from './dependency.cjs';
enum Count { Start = 10 }
namespace Label { export const text = ${JSON.stringify(label)}; }
class State { constructor(public n: number) {} }
let calls = 0;
export function perception() { return {text: Label.text + ':' + new State(Count.Start).n + ':' + (++calls) + ':' + suffix}; }
`;
  for (const folder of [dir, piDir]) {
    writeFileSync(join(folder, "perception.ts"), source("first"));
    writeFileSync(join(folder, "dependency.cjs"), "exports.suffix = 'dependency-one';");
  }
  const pi = loadPerception(piPath);
  const piB = loadPerception(piPath);
  const runtime = await start();
  try {
    assert.equal(statSync(dirname(runtime.socketPath)).mode & 0o777, 0o700);
    assert.equal(statSync(runtime.socketPath).mode & 0o777, 0o600);
    const call = (sessionId = world.sessionId) => runtime.call("perceive", { path, moment, world: { ...world, sessionId } });
    assert.deepEqual(await call(), await pi(moment as any, world as any));
    assert.deepEqual(await call(), { text: "first:10:2:dependency-one" });
    await pi(moment as any, world as any);
    assert.deepEqual(await call("session-b"), await piB(moment as any, world as any));
    for (const folder of [dir, piDir]) {
      writeFileSync(join(folder, "perception.ts"), source("edited"));
      writeFileSync(join(folder, "dependency.cjs"), "exports.suffix = 'dependency-two';");
    }
    assert.deepEqual(await call(), await pi(moment as any, world as any));
    await runtime.call("reload", { dir, sessionId: world.sessionId });
    assert.deepEqual(await call(), await loadPerception(piPath)(moment as any, world as any));
    assert.deepEqual(await call("session-b"), await piB(moment as any, world as any));

    const alternate = join(dir, "perception.mjs");
    writeFileSync(alternate, "export default () => ({ text: 'alternate' });");
    assert.deepEqual(await runtime.call("perceive", { path: alternate, moment, world }), { text: "alternate" });
    assert.deepEqual(await call(), await loadPerception(piPath)(moment as any, world as any));
  } finally { await runtime.stop(); }
});

test("standalone runtime keeps native JS/CJS, normal silence and independent soul caches", async () => {
  const runtime = await start();
  try {
    const write = (name: string, source: string) => {
      const dir = join(root, name);
      mkdirSync(dir);
      const path = join(dir, "perception.js");
      writeFileSync(path, source);
      return path;
    };
    const a = write("commonjs-a", "let count=0; module.exports = () => ({text:'a:'+ ++count});");
    const b = write("commonjs-b", "module.exports = {perception: () => ({text:'b'})};");
    const broken = write("broken", "throw new Error('broken import');");
    const throws = write("throws", "exports.perception = () => { throw new Error('broken call'); };");
    const invalid = write("invalid", "exports.perception = () => ({text:' '});");
    const call = (path: string) => runtime.call("perceive", { path, moment, world });
    assert.deepEqual(await call(a), { text: "a:1" });
    assert.deepEqual(await call(b), { text: "b" });
    assert.deepEqual(await call(a), { text: "a:2" });
    assert.deepEqual(await call(broken), {});
    assert.deepEqual(await call(throws), {});
    assert.deepEqual(await call(invalid), {});
    assert.deepEqual(await call(a), { text: "a:3" });
  } finally { await runtime.stop(); }
});

test("packaged native-import sidecar and Jiti attribution are exact source copies", () => {
  assert.deepEqual(readFileSync(join(hooks, "perception-import.mjs")), readFileSync(join(import.meta.dirname, "..", "src", "perception-import.mjs")));
  assert.deepEqual(readFileSync(join(hooks, "perception-runtime.LICENSE")), readFileSync(new URL("../LICENSE", import.meta.resolve("jiti"))));
});

// The documented host process stream backed by a real child, not an alternate
// runtime or parser. Closing the stream terminates its process before returning.
function bridgeHost() {
  const children: ReturnType<typeof spawn>[] = [];
  const sockets: string[] = [];
  const $ = {
    clock: { after: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) }; } },
    process: {
      run: async (argv: readonly string[]) => {
        const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 5_000 });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
      spawn: (input: ProcessSpawnRequest) => {
        const child = spawn(input.argv[0]!, input.argv.slice(1), { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        const pending: ProcessSpawnChunk[] = [];
        let wake: (() => void) | undefined;
        let ended = false;
        const result = new Promise<ProcessSpawnResult>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        void result.finally(() => { ended = true; wake?.(); }).catch(() => undefined);
        for (const stream of ["stdout", "stderr"] as const) {
          child[stream]!.setEncoding("utf8");
          child[stream]!.on("data", (text: string) => {
            if (stream === "stdout") {
              try { const ready = JSON.parse(text); if (ready.socketPath) sockets.push(ready.socketPath); } catch {}
            }
            pending.push({ stream, text });
            wake?.();
          });
        }
        const chunks = (async function* () {
          while (!ended || pending.length) {
            if (pending.length) yield pending.shift()!;
            else await new Promise<void>((resolve) => { wake = resolve; });
          }
          return result;
        })();
        const finish = chunks.return.bind(chunks);
        chunks.return = (value) => {
          child.kill("SIGTERM");
          return finish(value);
        };
        return Object.assign(chunks, { result });
      },
    },
    http: {
      fetch: async (_url: string, input: { socketPath: string; body: string }) => new Promise((resolve, reject) => {
        const req = request({ socketPath: input.socketPath, path: new URL(_url).pathname, method: "POST" }, (response) => {
          response.setEncoding("utf8");
          let text = "";
          response.on("data", (chunk) => { text += chunk; });
          response.on("end", () => resolve({ ok: response.statusCode === 200, text }));
        });
        req.on("error", reject);
        req.end(input.body);
      }),
    },
  } as unknown as EngineInterface;
  return { $, children, sockets };
}

const clientPath = join(hooks, "runtime-client.mjs");
writeFileSync(clientPath, `import.meta.dir = ${JSON.stringify(hooks)};\n${stripTypeScriptTypes(readFileSync(join(import.meta.dirname, "..", "plugins", "claude", "hooks", "perception-runtime.ts"), "utf8"))}`);
const { createPerceptionRuntime, runPerception, invalidateRuntime, reloadRuntime, stopRuntime } = await import(pathToFileURL(clientPath).href);
const waitFor = async (path: string) => {
  for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(path), "perception entered before invalidation");
};

test("retained bridge drops late switch/reload answers while preserving the child and other caches", async () => {
  const h = bridgeHost();
  const runtime = createPerceptionRuntime();
  const dir = join(root, "late");
  mkdirSync(dir);
  const marker = join(dir, "entered");
  const path = join(dir, "perception.mjs");
  writeFileSync(path, `import {writeFileSync} from 'node:fs'; let count=0; export async function perception(moment) {
    const n=++count; if(moment.text==='late') { writeFileSync(${JSON.stringify(marker)},''); await new Promise(r=>setTimeout(r,100)); }
    return {text:'call:'+n}; }`);
  const call = (text = "normal") => runPerception(h.$, runtime, { path, world, moment: { kind: "human", text } });
  try {
    const switched = call("late");
    await waitFor(marker);
    invalidateRuntime(runtime);
    assert.equal(await switched, undefined);
    assert.deepEqual(await call(), { text: "call:2" });
    rmSync(marker);
    const reloaded = call("late");
    await waitFor(marker);
    await reloadRuntime(h.$, runtime, world.sessionId, dir);
    assert.equal(await reloaded, undefined);
    assert.deepEqual(await call(), { text: "call:1" });
    assert.equal(h.children.length, 1);
    rmSync(marker);
    const ended = call("late");
    await waitFor(marker);
    await stopRuntime(h.$, runtime);
    assert.equal(await ended, undefined);
  } finally { await stopRuntime(h.$, runtime); }
  for (const socket of h.sockets) assert.equal(existsSync(dirname(socket)), false);
});

test("bridge abort and request timeout stop children, unlink sockets and allow a clean restart", async () => {
  const h = bridgeHost();
  const runtime = createPerceptionRuntime();
  const dir = join(root, "timeout");
  mkdirSync(dir);
  const path = join(dir, "perception.mjs");
  const marker = join(dir, "entered");
  writeFileSync(path, `import {writeFileSync} from 'node:fs'; export async function perception(moment) {
    if(moment.text==='hang') { writeFileSync(${JSON.stringify(marker)},''); await new Promise(()=>{}); } return {text:'recovered'}; }`);
  const task = (text: string) => ({ path, world, moment: { kind: "human", text } });
  try {
    const controller = new AbortController();
    const aborted = runPerception(h.$, runtime, task("hang"), controller.signal);
    await waitFor(marker);
    controller.abort();
    assert.equal(await aborted, undefined);
    for (const socket of h.sockets) assert.equal(existsSync(dirname(socket)), false);
    assert.deepEqual(await runPerception(h.$, runtime, task("normal")), { text: "recovered" });
    assert.equal(await runPerception(h.$, runtime, task("hang")), undefined);
    for (const socket of h.sockets) assert.equal(existsSync(dirname(socket)), false);
    assert.deepEqual(await runPerception(h.$, runtime, task("normal")), { text: "recovered" });
    assert.equal(h.children.length, 3);
  } finally { await stopRuntime(h.$, runtime); }
  for (const child of h.children) assert.ok(child.exitCode !== null || child.signalCode !== null);
  for (const socket of h.sockets) assert.equal(existsSync(dirname(socket)), false);
});

