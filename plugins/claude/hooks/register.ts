import type { EngineInterface, On, PluginOptions } from "claude-code";

type Engine = Pick<EngineInterface, "fs" | "env" | "session" | "ui" | "clock" | "process">;

declare global {
  /** The hooks module runs as a file of the plugin; its own URL locates the sibling runner. */
  interface ImportMeta {
    url: string;
  }
}

/** Executed by the host's `node`, never loaded here: this sandbox has no dynamic import and no Node. */
function runnerPath(): string | undefined {
  try {
    return new URL("./reaction-runner.mjs", import.meta.url).pathname;
  } catch {
    return undefined; // An environment without module URLs simply has no reaction.
  }
}

/** How the host saw a tool call; a reaction module reads this instead of parsing tool names. */
type ToolCategory = "reading" | "running" | "writing" | "other";

/** One lifecycle beat a soul may answer. Kept in step with `src/reaction.ts`. */
type Moment =
  | { kind: "wake"; source: "startup" | "resume" | "compact" | "clear" | "fork" }
  | { kind: "human"; text: string }
  | { kind: "tool"; phase: "before" | "after"; category: ToolCategory; toolName: string; filePath?: string; input?: string; output?: string; ok?: boolean }
  | { kind: "brain"; id: string; provider?: string }
  | { kind: "soul"; name: string };

/** Who reads an utterance; `model` is the default. */
type Audience = "model" | "human" | "both";

interface Utterance {
  text: string;
  audience?: Audience;
}

const CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  read: "reading", Read: "reading", grep: "reading", Grep: "reading",
  glob: "reading", Glob: "reading", find: "reading",
  bash: "running", Bash: "running", codemode: "running",
  edit: "writing", Edit: "writing", MultiEdit: "writing", write: "writing", Write: "writing",
};
const DETAIL_LIMIT = 2000;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Watch-face style: big time first, then the small date window. No year, like a real watch. */
function formatClock(now: number): string {
  const date = new Date(now);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} · ${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
function formatElapsed(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / 60_000);
  if (minutes === 60) return `${hours + 1}h`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
/**
 * Refresh the watch at most once an hour; the parenthetical appears only when the
 * human has actually been away for an hour or more. Undefined when neither is due.
 */
export function formatTimeContext(now: number, lastNoteAt?: number, lastHumanAt?: number): string | undefined {
  if (!Number.isFinite(now)) return undefined;
  const noteDue = lastNoteAt === undefined || !Number.isFinite(lastNoteAt) || now - lastNoteAt >= HOUR_MS;
  if (!noteDue) return undefined;
  const away = lastHumanAt !== undefined && Number.isFinite(lastHumanAt) && now - lastHumanAt >= HOUR_MS
    ? formatElapsed(now - lastHumanAt)
    : undefined;
  return away === undefined
    ? `⌚ ${formatClock(now)}`
    : `⌚ ${formatClock(now)}\n(${away} since *human* was last present)`;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value);
}
async function homeDir($: Engine): Promise<string | undefined> {
  return await $.env.get("HOME") ?? await $.env.get("USERPROFILE");
}
/** A directory soul is `<name>/SOUL.md`; a single-file soul stays `<name>.md`. */
async function load($: Engine, name: string): Promise<string> {
  if (!isName(name)) throw new Error(`Invalid soul: ${name}`);
  const home = await homeDir($);
  if (!home) throw new Error("Home directory unavailable");
  const nested = `${home}/.agents/souls/${name}/SOUL.md`;
  const path = await $.fs.exists(nested) ? nested : `${home}/.agents/souls/${name}.md`;
  if (!await $.fs.exists(path)) throw new Error(`Soul "${name}" not found`);
  const text = await $.fs.read(path);
  // Strip only a leading, closed YAML frontmatter block; no YAML runtime is needed.
  const body = text.replace(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/, "").trim();
  if (!body) throw new Error(`Soul "${name}" is empty`);
  return body;
}

/** Keep leading whitespace and the first paragraph's exact separator and suffix. */
export function replaceIdentity(text: string, body: string): string | undefined {
  const start = /^\s*/.exec(text)![0].length;
  if (!/^You are\b/.test(text.slice(start))) return undefined;
  const separator = /\r?\n[\t ]*\r?\n/.exec(text.slice(start));
  const end = separator ? start + separator.index : text.length;
  return text.slice(0, start) + body + text.slice(end);
}
async function warnOnce($: Engine, reported: Set<string>, message: string) {
  const key = `${await $.session.id()}:${message}`;
  if (reported.has(key)) return;
  reported.add(key);
  $.ui.log(`Soul: ${message}`);
}
async function select($: Engine, options: PluginOptions, model: string, reported: Set<string>): Promise<string | undefined> {
  let name = options.defaultSoul as string | undefined;
  for (const entry of (options.modelSouls ?? []) as readonly string[]) {
    const match = /^([^=\s]+)=([^=]+)$/.exec(entry);
    if (!match || !isName(match[2])) {
      await warnOnce($, reported, `Ignoring invalid model entry: ${JSON.stringify(entry)} (expected model=soul)`);
      continue;
    }
    if (match[1] === model) name = match[2];
  }
  return name || undefined;
}

interface Identity {
  model: string;
  /** The soul the host actually put in the prompt, or undefined when it has not shown one. */
  soul: string | null | undefined;
}

/** The path a tool call touches, from Claude's `file_path` or Pi's `path`. */
function toolPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as { path?: unknown; file_path?: unknown }).file_path ?? (input as { path?: unknown }).path;
  return typeof value === "string" && value ? value : undefined;
}

const ENVELOPE = new Set(["tool", "tool_use_id", "hook_event_name", "session_id", "transcript_path", "cwd"]);

/** A tool's own arguments: the classic `PreToolUse` envelope spreads them beside its own keys. */
function toolArgs(event: unknown): unknown {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
  const args = Object.entries(event).filter(([key]) => !ENVELOPE.has(key));
  return args.length ? Object.fromEntries(args) : undefined;
}

/** A tool argument or result as bounded text: strings as they are, anything else as JSON. */
function toolText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== "string") return undefined;
      text = json;
    } catch {
      return undefined;
    }
  }
  if (!text) return undefined;
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** Clock facts a reaction module can branch on without re-reading the clock. */
function facts(now: number): Record<string, unknown> {
  const date = new Date(now);
  const hour = date.getHours();
  const weekday = date.getDay();
  return {
    hour,
    morning: hour >= 5 && hour < 12,
    afternoon: hour >= 12 && hour < 17,
    evening: hour >= 17 && hour < 22,
    night: hour < 5 || hour >= 22,
    weekday,
    weekend: weekday === 0 || weekday === 6,
  };
}

/** The soul the mod would apply, or nothing when soulless or unnamed. */
async function soulName($: Engine, options: PluginOptions, reported: Set<string>): Promise<string | undefined> {
  if (/^(1|true)$/i.test(await $.env.get("SOULLESS") ?? "")) return undefined;
  return select($, options, await $.session.model(), reported);
}

/** A tool name mapped to the category a reaction module reads. */
function categoryOf(toolName: string): ToolCategory {
  return Object.hasOwn(CATEGORIES, toolName) ? CATEGORIES[toolName]! : "other";
}

/** A directory soul's executable reaction, when it ships one. */
async function reactionPath($: Engine, name: string): Promise<string | undefined> {
  const home = await homeDir($);
  if (!home) return undefined;
  for (const extension of [".ts", ".mjs", ".js"]) {
    const path = `${home}/.agents/souls/${name}/reaction${extension}`;
    if (await $.fs.exists(path)) return path;
  }
  return undefined;
}

function utterance(value: unknown): Utterance | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { text, audience } = value as { text?: unknown; audience?: unknown };
  if (typeof text !== "string" || !text.trim()) return undefined;
  const known = audience === "human" || audience === "both" || audience === "model" ? audience : undefined;
  return { text, ...(known ? { audience: known } : {}) };
}

/**
 * Run one soul's `reaction(moment, world)` in a Node child process: the sandbox has
 * no dynamic import, and a broken module must never break the host's request.
 */
async function react($: Engine, name: string, moment: Moment, absenceMs?: number): Promise<Utterance | undefined> {
  try {
    const runner = runnerPath();
    if (!runner) return undefined;
    const path = await reactionPath($, name);
    if (!path) return undefined;
    const home = await homeDir($) ?? "";
    const now = await $.clock.now();
    const world = {
      now,
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
      storeDir: `${home}/.local/share/pi-souls/${name}`,
      facts: facts(now),
      ...(absenceMs !== undefined && Number.isFinite(absenceMs) && absenceMs >= 0 ? { absenceMs } : {}),
    };
    const { exitCode, stdout } = await $.process.run(
      ["node", "--experimental-strip-types", runner, path, JSON.stringify({ moment, world })],
      { timeoutMs: 10_000 },
    );
    if (exitCode !== 0) return undefined;
    // The last line is the runner's answer; a reaction module may print on its own.
    const line = stdout.trim().split("\n").pop();
    return line ? utterance(JSON.parse(line)) : undefined;
  } catch {
    return undefined;
  }
}

/** A human reads it in a toast; the model reads it as extra context. */
function shown(said: Utterance): boolean {
  return said.audience === "human" || said.audience === "both";
}
/** What the model reads: everything but a human-only utterance. */
function told(said: Utterance): string | undefined {
  return said.audience === "human" ? undefined : said.text;
}
/** A classic result with the utterance added: the host's own fields pass through untouched. */
function withContext<T extends { additionalContext?: string[] }>($: Engine, result: T, said: Utterance | undefined): T {
  if (!said) return result;
  if (shown(said)) $.ui.toast(said.text);
  const text = told(said);
  return text ? { ...result, additionalContext: [...(result.additionalContext ?? []), text] } : result;
}

interface SessionState {
  baseline?: Identity;
  /** Only a successful prompt.compose replacement is evidence of the active soul. */
  applied?: { model: string; soul: string };
}

interface PromptState {
  /** When the last time note was delivered. */
  noteAt?: number;
  /** When the human last submitted a prompt. */
  humanAt?: number;
}

function transitionLines(previous: Identity, current: Identity): string[] {
  const lines: string[] = [];
  if (previous.model !== current.model) lines.push(`new brain: ${current.model}`);
  if (previous.soul !== undefined && current.soul !== undefined && previous.soul !== current.soul && current.soul !== null) {
    lines.push(`new soul: ${current.soul}`);
  }
  return lines;
}

export function register(on: On, options: PluginOptions = {}) {
  const reported = new Set<string>();
  // Transient, like the rest of this host's session state; the engine's framing wraps context.
  const sessions = new Map<string, SessionState>();
  const promptStates = new Map<string, PromptState>();
  /** How long the human has been away, when this session already heard from them. */
  const absence = async ($: Engine): Promise<number | undefined> => {
    try {
      const state = promptStates.get(await $.session.id());
      return state?.humanAt === undefined ? undefined : Math.max(0, (await $.clock.now()) - state.humanAt);
    } catch {
      return undefined;
    }
  };

  on("classic.SessionStart", async ($, e, next) => {
    const result = await next(e);
    try {
      const name = await soulName($, options, reported);
      if (!name) return result;
      const absenceMs = typeof e.seconds_since_last_response === "number" ? e.seconds_since_last_response * 1000 : undefined;
      return withContext($, result, await react($, name, { kind: "wake", source: e.source }, absenceMs));
    } catch {
      return result;
    }
  });

  on("classic.PreToolUse", async ($, e, next) => {
    const result = await next(e);
    try {
      const name = await soulName($, options, reported);
      if (!name) return result;
      const args = toolArgs(e);
      const filePath = toolPath(args);
      const input = toolText(args);
      return withContext($, result, await react($, name, {
        kind: "tool", phase: "before", category: categoryOf(e.tool), toolName: e.tool,
        ...(filePath ? { filePath } : {}), ...(input ? { input } : {}),
      }, await absence($)));
    } catch {
      return result;
    }
  });

  /** The tool moment the two result hooks share; `output` is the response or the failure. */
  const toolNote = async ($: Engine, toolName: string, input: unknown, ok: boolean, output?: unknown): Promise<Utterance | undefined> => {
    try {
      const name = await soulName($, options, reported);
      if (!name) return undefined;
      const filePath = toolPath(input);
      const detail = toolText(input);
      const seen = toolText(output);
      return await react($, name, {
        kind: "tool", phase: "after", category: categoryOf(toolName), toolName,
        ...(filePath ? { filePath } : {}), ...(detail ? { input: detail } : {}), ...(seen ? { output: seen } : {}), ok,
      }, await absence($));
    } catch {
      return undefined;
    }
  };

  on("classic.PostToolUse", async ($, e, next) => {
    const result = await next(e);
    return withContext($, result, await toolNote($, e.tool_name, e.tool_input, true, e.tool_response));
  });

  on("classic.PostToolUseFailure", async ($, e, next) => {
    const result = await next(e);
    return withContext($, result, await toolNote($, e.tool_name, e.tool_input, false, e.error));
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    try {
      if (/^(1|true)$/i.test(await $.env.get("SOULLESS") ?? "")) return result;
      const name = await select($, options, e.model, reported);
      if (!name) return result;
      const target = e.traits.includes("lean") ? "lean_body" : "intro";
      const index = result.sections.findIndex((section) => section.id === target);
      const section = result.sections[index];
      if (!section) {
        await warnOnce($, reported, "Skipped: no matching opening paragraph");
        return result;
      }
      const text = replaceIdentity(section.text, await load($, name));
      if (text === undefined) {
        await warnOnce($, reported, "Skipped: no matching opening paragraph");
        return result;
      }
      const id = await $.session.id().catch(() => undefined);
      if (id) {
        const state = sessions.get(id) ?? {};
        state.applied = { model: e.model, soul: name };
        sessions.set(id, state);
      }
      return { ...result, sections: result.sections.map((item, i) => i === index ? { ...item, text } : item) };
    } catch (error) {
      await warnOnce($, reported, `Skipped: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  });

  on("prompt.submit", async ($, e, next) => {
    if (e.command || e.isMeta) return next(e);
    const notes: string[] = [];
    let timeNote: string | undefined;

    // A soul's presence is recorded whenever a soul applies, whether or not time notes are on.
    let presence: { id: string; now: number } | undefined;
    try {
      if (!/^(1|true)$/i.test(await $.env.get("SOULLESS") ?? "")) {
        const name = await select($, options, await $.session.model(), reported);
        if (name) {
          if (options.timeaware !== false) await load($, name);
          presence = { id: await $.session.id(), now: await $.clock.now() };
        }
      }
    } catch {
      presence = undefined;
    }
    const sessionId = presence?.id;
    const now = presence?.now;
    // Watch-style time awareness: only when a soul would actually be applied.
    if (presence && options.timeaware !== false) {
      const state = promptStates.get(presence.id);
      timeNote = formatTimeContext(presence.now, state?.noteAt, state?.humanAt);
      if (timeNote !== undefined) notes.push(timeNote);
    }

    let id: string | undefined;
    let previous: Identity | undefined;
    let current: Identity | undefined;
    let state: SessionState | undefined;
    try {
      id = await $.session.id();
      const model = await $.session.model();
      state = sessions.get(id) ?? {};
      sessions.set(id, state);
      previous = state.baseline;
      const applied = state.applied?.model === model ? state.applied.soul : undefined;
      current = {
        model,
        soul: applied !== undefined ? applied : previous?.soul,
      };
    } catch {
      return next(notes.length ? { ...e, context: [...(e.context ?? []), ...notes] } : e);
    }
    let transitionNote: string | undefined;
    if (previous && (previous.model !== current.model || previous.soul !== current.soul)) {
      const lines = transitionLines(previous, current);
      if (lines.length) {
        transitionNote = lines.join("\n");
        notes.push(transitionNote);
      }
    }

    // The soul answers the human's words; a model-facing line rides the context like a note.
    try {
      const name = await soulName($, options, reported);
      const said = name ? await react($, name, { kind: "human", text: e.text }, await absence($)) : undefined;
      if (said) {
        if (shown(said)) $.ui.toast(said.text);
        const text = told(said);
        if (text) notes.push(text);
      }
    } catch {}

    // Let a downstream rejection propagate; calling next twice would submit twice.
    const result = await next(notes.length ? { ...e, context: [...(e.context ?? []), ...notes] } : e);

    if (!("drop" in result)) {
      if (sessionId !== undefined && now !== undefined) {
        const promptState = promptStates.get(sessionId) ?? {};
        promptState.humanAt = now;
        if (timeNote !== undefined && result.context?.includes(timeNote)) promptState.noteAt = now;
        promptStates.set(sessionId, promptState);
      }
      // A dropped prompt or a downstream hook that strips the block did not deliver it.
      if (state !== undefined && current !== undefined && (!previous || transitionNote === undefined || result.context?.includes(transitionNote))) {
        state.baseline = current;
      }
    }
    return result;
  });

  on("session.end", async ($, e, next) => {
    try {
      const id = await $.session.id();
      sessions.delete(id);
      promptStates.delete(id);
    } catch {}
    return next(e);
  });
}
