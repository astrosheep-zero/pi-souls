/// <reference path="../plugins/claude/types/claude-code.d.ts" />
/**
 * Local Claude Code wire harness for tests. It launches the actual installed binary in
 * print/stream-json mode against a loopback Anthropic-compatible mock, with an isolated
 * HOME/config/cwd and one copied, built plugin. It never talks to a real model.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WireEvent = { type: string; [key: string]: any };
export type WireRequest = { url: string; headers: IncomingHttpHeaders; body: any; at: number };

/** One Anthropic content block on the wire. */
export type WireContentBlock = { type: string; [key: string]: any };
export type WireMessage = { role: string; content: string | WireContentBlock[] };

export function blocks(message: WireMessage | undefined): WireContentBlock[] {
  const content = message?.content;
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
}

/** Note payloads in these fixtures are single lines. Claude may add unattributed or attributed framing. */
export function wireNoteLines(message: WireMessage): string[] {
  return blocks(message).flatMap((block) => block.type === "text" && typeof block.text === "string" ? block.text.split("\n") : []);
}

export function ownPluginNote(row: WireEvent): { delivered: string[]; held: string[] } | undefined {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
  if (row.type === "attachment" && row.attachment?.type === "plugin_note" && row.attachment.plugin === "pi-souls") {
    return { delivered: strings(row.attachment.content), held: strings(row.attachment.heldContent) };
  }
  if (row.type === "user" && row.isMeta === true && row.message?.role === "user"
    && row.origin?.kind === "plugin" && row.origin.name === "pi-souls") {
    return { delivered: blocks(row.message).filter((block) => block.type === "text").flatMap((block) => typeof block.text === "string" ? [block.text] : []), held: [] };
  }
}
export type WireMockResponse = {
  content: WireContentBlock[];
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};
export type WireReply = string | WireMockResponse;
export type WireResponder = WireReply | ((body: any) => WireReply);

export type WireHostOptions = {
  /** Use this directory as the harness root instead of a fresh mkdtemp. */
  dir?: string;
  tempRoot?: string;
  home?: string;
  configDir?: string;
  cwd?: string;
  soulsDir?: string;
  /** Soul name -> raw file body; written before launch. */
  souls?: Record<string, string>;
  /** Built plugin directory; defaults to this repository's plugins/claude. */
  pluginDir?: string;
  binary?: string;
  model?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  /** Mock assistant reply: text, structured content blocks (text/tool_use), or a function of the request body. */
  response?: WireResponder;
  /** Built-in tools to expose, e.g. ["Read"]; defaults to none, and each is also allowed. */
  tools?: string[];
  debug?: boolean;
  resume?: string;
  forkSession?: boolean;
  sessionId?: string;
  timeoutMs?: number;
};

export type WireTurn = {
  events: WireEvent[];
  result: WireEvent;
  requests: WireRequest[];
  apiBodies: any[];
};

export type WireControl = {
  requestId: string;
  /** Raw control_response.response (subtype success/error, request_id, response/error). */
  response: any;
  event: WireEvent;
  events: WireEvent[];
};

type Waiter = {
  predicate: (event: WireEvent) => boolean;
  resolve: (value: { event: WireEvent; events: WireEvent[] }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  start: number;
};

export type WireHost = {
  readonly dir: string;
  readonly home: string;
  readonly configDir: string;
  readonly cwd: string;
  readonly pluginDir: string;
  readonly url: string;
  readonly child: ChildProcess;
  readonly launch: { binary: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };
  readonly requests: WireRequest[];
  readonly apiBodies: any[];
  readonly events: WireEvent[];
  readonly stderr: () => string;
  sessionId: string | undefined;
  readonly transcriptPath: string | undefined;
  send(text: string, options?: { timeoutMs?: number }): Promise<WireTurn>;
  /** Write one raw control_request and await its control_response. */
  control(request: { subtype: string; [key: string]: unknown }, options?: { timeoutMs?: number }): Promise<WireControl>;
  transcript(): Promise<WireEvent[] | undefined>;
  writeSoul(name: string, body: string): void;
  stop(): Promise<void>;
};

const DEFAULT_TIMEOUT = 120_000;

function safeText(value: unknown): string {
  return typeof value === "string" ? value : "mock reply";
}

function mockReply(body: any, response: WireResponder | undefined, messageId: string): Required<Pick<WireMockResponse, "content" | "stop_reason" | "model">> & Pick<WireMockResponse, "usage"> {
  let value: WireReply;
  if (typeof response === "function") {
    try { value = response(body); } catch { value = "mock reply"; }
  } else {
    value = response ?? "mock reply";
  }
  const structured = typeof value === "object" && value !== null && Array.isArray(value.content) ? value : undefined;
  const content: WireContentBlock[] = structured
    ? structured.content
    : [{ type: "text", text: safeText(value) }];
  const used = new Set<string>();
  return {
    content: content.map((block, index) => {
      if (block?.type !== "tool_use") return block;
      let id = typeof block.id === "string" && block.id ? block.id : `toolu_wire${messageId.replace(/\D/g, "")}_${index}`;
      while (used.has(id)) id = `${id}_${index}`;
      used.add(id);
      return { ...block, id, name: block.name, input: block.input ?? {} };
    }),
    stop_reason: structured?.stop_reason ?? "end_turn",
    model: structured?.model ?? body.model,
    usage: structured?.usage,
  };
}

async function serveMock(response: WireResponder | undefined): Promise<{
  server: Server; url: string; requests: WireRequest[]; apiBodies: any[];
}> {
  const requests: WireRequest[] = [];
  const apiBodies: any[] = [];
  let seq = 0;
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      if (!req.url?.includes("/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      let body: any;
      try { body = JSON.parse(text); } catch { res.writeHead(400); res.end("invalid json"); return; }
      requests.push({ url: req.url, headers: req.headers, body, at: Date.now() });
      apiBodies.push(body);
      const id = `msg_wire${++seq}`;
      const reply = mockReply(body, response, id);
      const usage = {
        input_tokens: 100, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        ...reply.usage,
      };
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id, type: "message", role: "assistant", model: reply.model,
          content: reply.content, stop_reason: reply.stop_reason, stop_sequence: null, usage,
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (type: string, data: Record<string, unknown>) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      };
      send("message_start", { message: { id, type: "message", role: "assistant", model: reply.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
      reply.content.forEach((block, index) => {
        if (block.type === "text") {
          send("content_block_start", { index, content_block: { type: "text", text: "" } });
          if (block.text) send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
        } else if (block.type === "tool_use") {
          send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
          send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
        } else {
          send("content_block_start", { index, content_block: block });
        }
        send("content_block_stop", { index });
      });
      send("message_delta", { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      send("message_stop", {});
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server has no TCP address");
  return { server, url: `http://127.0.0.1:${address.port}`, requests, apiBodies };
}

/** Launch the real binary against the loopback mock; all environment is isolated. */
export async function createWireHost(options: WireHostOptions = {}): Promise<WireHost> {
  const dir = options.dir ?? options.tempRoot ?? mkdtempSync(join(tmpdir(), "pi-souls-wire-"));
  const home = options.home ?? join(dir, "home");
  const configDir = options.configDir ?? join(dir, "claude-config");
  const cwd = options.cwd ?? join(dir, "work");
  const soulsDir = options.soulsDir ?? join(home, ".agents", "souls");
  const repo = join(import.meta.dirname, "..");
  const sourcePlugin = options.pluginDir ?? join(repo, "plugins", "claude");
  const pluginDir = join(dir, "plugin");
  const binary = options.binary ?? "/opt/homebrew/bin/claude";
  const model = options.model ?? "claude-opus-5-5";
  for (const path of [home, configDir, cwd, soulsDir]) mkdirSync(path, { recursive: true });
  if (!existsSync(join(sourcePlugin, "hooks", "hooks.json"))) throw new Error(`Missing built plugin at ${sourcePlugin}`);
  rmSync(pluginDir, { recursive: true, force: true });
  cpSync(sourcePlugin, pluginDir, { recursive: true });

  const writeSoul = (name: string, body: string) => {
    if (!/^[^/\\]+$/.test(name)) throw new Error(`Invalid soul name: ${name}`);
    mkdirSync(soulsDir, { recursive: true });
    writeFileSync(join(soulsDir, `${name}.md`), body);
  };
  for (const [name, body] of Object.entries(options.souls ?? {})) writeSoul(name, body);

  const mock = await serveMock(options.response);
  const args = [
    "-p",
    "--plugin-dir", pluginDir,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--tools", options.tools?.join(",") ?? "",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
  ];
  if (options.tools?.length) args.push("--allowedTools", options.tools.join(","));
  if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.resume) args.push("--resume", options.resume);
  if (options.forkSession) args.push("--fork-session");
  if (options.debug) args.push("--debug-file", join(dir, "debug.txt"));
  args.push(...(options.args ?? []));

  // Never let an inherited provider/proxy setting point this process at a real service.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  for (const key of [
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
  ]) delete env[key];
  Object.assign(env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "mock-wire-local",
    ANTHROPIC_BASE_URL: mock.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_UPDATE_CHECK: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    OTEL_SDK_DISABLED: "true",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });

  const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const events: WireEvent[] = [];
  const waiters: Waiter[] = [];
  const unparsed: string[] = [];
  let stderr = "";
  let sessionId = options.sessionId ?? options.resume;
  let controlSeq = 0;
  let stopped = false;
  const launch = { binary, args, env, cwd };

  const failWaiters = (message: string) => {
    while (waiters.length) {
      const waiter = waiters.pop()!;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  };
  const handleEvent = (event: WireEvent) => {
    events.push(event);
    if (event.type === "result" && typeof event.session_id === "string") sessionId = event.session_id;
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!;
      if (!waiter.predicate(event)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve({ event, events: events.slice(waiter.start) });
    }
  };
  const waitFor = (predicate: (event: WireEvent) => boolean, timeoutMs: number) =>
    new Promise<{ event: WireEvent; events: WireEvent[] }>((resolve, reject) => {
      const waiter: Waiter = {
        predicate, resolve, reject, start: events.length,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for Claude stream event`));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { handleEvent(JSON.parse(line) as WireEvent); } catch { unparsed.push(line); }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", (error) => { if (!stopped) failWaiters(`Claude process error: ${error.message}`); });
  child.on("exit", (code, signal) => {
    if (!stopped) failWaiters(`Claude exited (${code ?? signal}) before the awaited stream event`);
  });

  const write = (payload: unknown) => {
    if (stopped || !child.stdin?.writable) throw new Error("Claude stdin is closed");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const locateTranscript = (): string | undefined => {
    if (!sessionId) return undefined;
    const projects = join(configDir, "projects");
    try {
      for (const entry of readdirSync(projects, { recursive: true })) {
        if (typeof entry !== "string") continue;
        if (entry === `${sessionId}.jsonl` || entry.endsWith(`/${sessionId}.jsonl`)) return join(projects, entry);
      }
    } catch { /* no transcript yet */ }
    return undefined;
  };

  const host: WireHost = {
    dir, home, configDir, cwd, pluginDir, url: mock.url, child, launch,
    requests: mock.requests, apiBodies: mock.apiBodies, events,
    stderr: () => stderr,
    get sessionId() { return sessionId; },
    set sessionId(value: string | undefined) { sessionId = value; },
    get transcriptPath() { return locateTranscript(); },
    async send(text, sendOptions = {}) {
      const start = mock.requests.length;
      const waiting = waitFor((event) => event.type === "result", sendOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT);
      write({ type: "user", message: { role: "user", content: text } });
      const { event, events: turnEvents } = await waiting;
      return {
        events: turnEvents,
        result: event,
        requests: mock.requests.slice(start),
        apiBodies: mock.apiBodies.slice(start),
      };
    },
    async control(request, controlOptions = {}) {
      const requestId = `wire-control-${++controlSeq}`;
      const waiting = waitFor((event) => event.type === "control_response"
        && (event.request_id === requestId || event.response?.request_id === requestId),
      controlOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT);
      write({ type: "control_request", request_id: requestId, request });
      const { event, events: controlEvents } = await waiting;
      return { requestId, response: event.response ?? event, event, events: controlEvents };
    },
    async transcript() {
      const path = locateTranscript();
      if (!path) return undefined;
      const deadline = Date.now() + 2_000;
      while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!existsSync(path)) return undefined;
      return readFileSync(path, "utf8").split("\n").flatMap((line) => {
        if (!line.trim()) return [];
        try { return [JSON.parse(line) as WireEvent]; } catch { return []; }
      });
    },
    writeSoul,
    async stop() {
      if (stopped) return;
      stopped = true;
      failWaiters("Claude wire host stopped");
      try { child.stdin?.end(); } catch { /* already closed */ }
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
      });
      const term = setTimeout(() => child.kill("SIGTERM"), 2_000);
      let force: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => { force = setTimeout(resolve, 6_000); }),
      ]);
      clearTimeout(term);
      clearTimeout(force);
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
      mock.server.closeAllConnections();
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    },
  };
  return host;
}
