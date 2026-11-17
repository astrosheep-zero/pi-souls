import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Timer } from "claude-code";

type Host = Pick<EngineInterface, "process" | "http" | "clock">;
const RUNTIME = `${import.meta.dir}/perception-runtime.mjs`;
const TIMEOUT_MS = 10_000;

interface Child {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>;
  ready: Promise<string>;
  socket?: string;
  cleanup?: Promise<void>;
}

/** Plain per-session state; actor-bearing operations stay statically followable. */
export interface PerceptionRuntime {
  child?: Child;
  generation: number;
}
export const createPerceptionRuntime = (): PerceptionRuntime => ({ generation: 0 });
export function invalidateRuntime(state: PerceptionRuntime): void { state.generation++; }

async function cleanup($: Host, child: Child): Promise<void> {
  if (!child.socket) return;
  // Default signal termination can skip Node's exit hook. After closing the
  // stream, remove only the helper's own private socket layout.
  child.cleanup ??= $.process.run(["node", RUNTIME, "--cleanup", child.socket], { timeoutMs: 2_000 }).then(() => undefined, () => undefined);
  await child.cleanup;
}

export async function stopRuntime($: Host, state: PerceptionRuntime, expected = state.child): Promise<void> {
  if (expected !== state.child) return;
  invalidateRuntime(state);
  if (!expected) return;
  await expected.stream.return({ code: null, signal: null }).catch(() => undefined);
  await cleanup($, expected);
  if (state.child === expected) state.child = undefined;
}

async function drain($: Host, state: PerceptionRuntime, child: Child, ready: (socket: string) => void, failed: (error: Error) => void): Promise<void> {
  let pending = "";
  try {
    for await (const chunk of child.stream) {
      if (child.socket || chunk.stream !== "stdout") continue;
      pending += chunk.text;
      const end = pending.indexOf("\n");
      if (end < 0) {
        if (pending.length > 16_384) throw new Error("Invalid runtime readiness");
        continue;
      }
      const message = JSON.parse(pending.slice(0, end));
      if (typeof message.socketPath !== "string") throw new Error("Missing runtime socket");
      child.socket = message.socketPath;
      ready(message.socketPath);
    }
  } catch {
    // Startup, process failures and soul stdout never escape a host hook.
  } finally {
    failed(new Error("Perception runtime stopped"));
    if (state.child === child) invalidateRuntime(state);
    // Keep the handle until cleanup settles so session.end can await a drain
    // that began when the host released its process stream during shutdown.
    await cleanup($, child);
    if (state.child === child) state.child = undefined;
  }
}

function start($: Host, state: PerceptionRuntime): Child {
  if (state.child) return state.child;
  const stream = $.process.spawn({ argv: ["node", RUNTIME] });
  void stream.result.catch(() => undefined);
  let ready!: (socket: string) => void;
  let failed!: (error: Error) => void;
  const child: Child = { stream, ready: new Promise((resolve, reject) => { ready = resolve; failed = reject; }) };
  state.child = child;
  void drain($, state, child, ready, failed).catch(() => undefined);
  return child;
}

async function request($: Host, state: PerceptionRuntime, child: Child, generation: number, operation: string, task: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const socketPath = await child.ready;
  if (generation !== state.generation || signal?.aborted) return undefined;
  const response = await $.http.fetch(`http://perception/${operation}`, {
    method: "POST", socketPath, body: JSON.stringify(task),
  });
  if (!response.ok || generation !== state.generation || signal?.aborted) return undefined;
  return JSON.parse(response.text);
}

async function invoke($: Host, state: PerceptionRuntime, operation: string, task: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const generation = state.generation;
  let child: Child | undefined;
  let timer: Timer | undefined;
  let abort: (() => void) | undefined;
  try {
    child = start($, state);
    return await Promise.race([
      request($, state, child, generation, operation, task, signal),
      new Promise<never>((_, reject) => {
        timer = $.clock.after(TIMEOUT_MS, () => reject(new Error("Perception runtime timeout")));
        abort = () => reject(new Error("Perception aborted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } catch {
    if (child) await stopRuntime($, state, child);
    return undefined;
  } finally {
    timer?.cancel();
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function runPerception($: Host, state: PerceptionRuntime, task: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return invoke($, state, "perceive", task, signal);
}

export async function reloadRuntime($: Host, state: PerceptionRuntime, sessionId: string, dir: string): Promise<void> {
  invalidateRuntime(state);
  if (state.child) await invoke($, state, "reload", { sessionId, dir });
}
