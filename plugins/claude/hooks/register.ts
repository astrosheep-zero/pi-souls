import type { EngineInterface, On, PluginOptions } from "claude-code";

type Engine = Pick<EngineInterface, "fs" | "env" | "session" | "ui" | "clock">;

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
async function load($: Engine, name: string): Promise<string> {
  if (!isName(name)) throw new Error(`Invalid soul: ${name}`);
  const home = await $.env.get("HOME") ?? await $.env.get("USERPROFILE");
  if (!home) throw new Error("Home directory unavailable");
  const path = `${home}/.agents/souls/${name}.md`;
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
    let sessionId: string | undefined;
    let now: number | undefined;
    let timeNote: string | undefined;

    // Watch-style time awareness: only when a soul would actually be applied.
    if (options.timeaware !== false) {
      try {
        if (!/^(1|true)$/i.test(await $.env.get("SOULLESS") ?? "")) {
          const name = await select($, options, await $.session.model(), reported);
          if (name) {
            await load($, name);
            sessionId = await $.session.id();
            now = await $.clock.now();
            const state = promptStates.get(sessionId);
            timeNote = formatTimeContext(now, state?.noteAt, state?.humanAt);
            if (timeNote !== undefined) notes.push(timeNote);
          }
        }
      } catch {
        sessionId = undefined;
        now = undefined;
        timeNote = undefined;
      }
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
