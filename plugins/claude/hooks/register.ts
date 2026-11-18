import type { On, PluginOptions, PromptComposeSection, SessionMessage } from "claude-code";
import { isSoulName, matchingModelKey } from "../../../src/soul-selection.ts";
import { encodeChoice, type ClaudeSession, type SoulChoice } from "../../../src/claude-session.ts";
import { timePerception } from "../../../src/time.ts";
import { files, load, type Engine } from "./files.ts";
import { perceive, toolMoment, worldFor, type Moment } from "./perception.ts";
import { createPerceptionRuntime, invalidateRuntime, reloadRuntime, stopRuntime, type PerceptionRuntime } from "./perception-runtime.ts";

const DEFAULTS: SoulChoice = { mode: "defaults" };
const PRONOUNS = "pronouns";
const GUIDANCE = "session_guidance";
type IdentitySlot = typeof PRONOUNS | typeof GUIDANCE;
interface NativeOpening {
  body: string;
  raw: string;
  rest: string;
  /** Native remainder followed by the original second section, for matching a folded snapshot. */
  foldedTail?: string;
}
const ENVELOPE = new Set(["tool", "tool_use_id", "hook_event_name", "session_id", "transcript_path", "cwd"]);
interface Projection {
  soul: string | null;
  icon?: string;
  /** Exact composed section and shared opening remainder, checked against the recorded snapshot. */
  section: string;
  opening: string;
}
interface State {
  sessionId?: string;
  transcriptPath?: string;
  head?: string;
  journalHead?: string;
  journal: ClaudeSession;
  choice: SoulChoice;
  choiceKnown: boolean;
  seeding: boolean;
  native?: NativeOpening;
  compactedOpening?: string;
  sectionIdentity?: { slot: IdentitySlot; soul: string | null; icon?: string };
  proposals: Map<string, Projection>;
  applied?: Projection;
  observed?: string | null;
  suppression: string;
  human?: { text: string; now: number; previousHumanAt?: number };
  wake?: Extract<Moment, { kind: "wake" }>;
  pendingBrain?: string;
  pendingChoice?: { choice: SoulChoice; args: string };
  renderModel?: string;
  toolNotes: { text: string; generation: number }[];
  runtime: PerceptionRuntime;
  reported: Set<string>;
}

/** Keep the leading whitespace and every byte after the native first paragraph. */
export function openingParagraph(text: string): { body: string; rest: string } | undefined {
  const start = /^\s*/.exec(text)![0].length;
  if (!/^You are\b/.test(text.slice(start))) return undefined;
  const separator = /\r?\n[\t ]*\r?\n/.exec(text.slice(start));
  const end = separator ? start + separator.index : text.length;
  return { body: text.slice(start, end), rest: text.slice(0, start) + text.slice(end) };
}

function identitySlot(s: State): IdentitySlot | undefined {
  const native = s.native;
  if (!native || !s.choiceKnown) return undefined;
  const first = s.journal.snapshot?.systemPrompt[0];
  // A resumed snapshot owns its layout; never project over an unrecognized
  // opening. Native compaction releases that snapshot, even if its attachment
  // is still visible through ancestry until the next request records a new one.
  if (first === native.rest) return GUIDANCE;
  if (native.foldedTail && first?.endsWith(native.foldedTail)) return PRONOUNS;
  if (first === undefined || first === s.compactedOpening) return native.foldedTail ? PRONOUNS : GUIDANCE;
  return undefined;
}

// The sandbox follows $ only through top-level functions, including bundled modules.
function warn($: Engine, s: State, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  if (!s.reported.has(text)) { s.reported.add(text); $.ui.log(`Soul: ${text}`); }
}
async function hydrate($: Engine, s: State, options: PluginOptions, handles?: string[], rewind = false): Promise<void> {
  if (!s.head || !s.transcriptPath || (s.head === s.journalHead && handles === undefined && !rewind)) return;
  // The writer can trail a kept append. Never substitute a different leaf.
  for (const delay of [0, 15, 40, 100]) {
    if (delay) await $.clock.sleep(delay);
    const result = await files<ClaudeSession>($, options, { op: "session", transcriptPath: s.transcriptPath, headUuid: s.head, ...(handles ? { handles } : {}), ...(rewind ? { sessionId: s.sessionId } : {}) });
    if (!result.known) continue;
    if (result.headUuid !== undefined) {
      invalidateRuntime(s.runtime);
      s.head = result.headUuid ?? undefined;
      s.pendingChoice = undefined; s.pendingBrain = undefined; s.human = undefined; s.toolNotes = [];
      s.compactedOpening = undefined;
      s.observed = undefined; s.applied = undefined; status($, s);
    }
    s.journal = result; s.journalHead = s.head;
    s.choice = result.choice ?? DEFAULTS; s.choiceKnown = true;
    return;
  }
  throw new Error("Could not read this session’s soul settings yet. Please try again.");
}
async function selected($: Engine, s: State, options: PluginOptions, model: string, choice = s.choice, known = s.choiceKnown): Promise<string | undefined> {
  if (!known) return undefined;
  if (choice.mode === "named") return choice.name;
  if (choice.mode === "disabled" || /^(1|true)$/i.test(await $.env.get("SOULLESS") ?? "")) return undefined;
  const mappings = new Map<string, string>();
  for (const entry of (options.modelSouls ?? []) as readonly string[]) {
    const match = /^([^=\s]+)=([^=]+)$/.exec(entry);
    if (!match || !isSoulName(match[2])) warn($, s, `Ignoring invalid model entry: ${JSON.stringify(entry)} (expected model=soul)`);
    else mappings.set(match[1]!, match[2]);
  }
  const key = matchingModelKey(model, [...mappings.keys()]);
  const name = key === undefined ? options.defaultSoul : mappings.get(key);
  if (name === undefined || name === "") return undefined;
  if (!isSoulName(name)) throw new Error(`Invalid default soul: ${JSON.stringify(name)}`);
  return name;
}
async function append($: Engine, s: State, type: "user" | "system", text: string): Promise<boolean> {
  const result = await $.session.append({ message: { type, content: [{ type: "text", text }] } });
  if (result.deny !== undefined) { warn($, s, result.deny); return false; }
  s.head = result.uuid; s.journalHead = undefined;
  return true;
}
function reminder($: Engine, s: State, text: string): Promise<boolean> {
  return append($, s, "user", `<system-reminder>\n${text}\n</system-reminder>`);
}
function invalidate($: Engine): void { $.ui.invalidate("prompt.section"); }
function status($: Engine, s: State): void { $.ui.status(s.applied?.soul ? s.applied.icon ?? s.applied.soul : undefined); }
function prove($: Engine, s: State): Projection | undefined {
  const parts = s.journal.snapshot?.systemPrompt;
  const proposal = parts && [...s.proposals.values()].find((p) => parts[0] === p.opening && parts.includes(p.section));
  if (s.applied?.soul !== proposal?.soul) invalidateRuntime(s.runtime);
  s.applied = proposal;
  s.suppression = proposal ? "" : s.journal.snapshot ? "Claude is using a custom or older system prompt. For an older session, run /compact or start a new session to enable soul switching." : "send a message to see the active soul";
  status($, s);
  return proposal;
}
async function preview($: Engine, model?: string): Promise<void> {
  invalidate($);
  await $.prompt.compose(model ? { model } : {});
}
async function perceiveActive($: Engine, s: State, options: PluginOptions, moment: Moment, absenceMs?: number, now?: number, signal?: AbortSignal): Promise<void> {
  const name = s.applied?.soul;
  const generation = s.runtime.generation;
  if (!name) return;
  try {
    const world = await worldFor($, name, absenceMs, now);
    if (world.absenceMs === undefined && s.journal.lastHumanAt !== undefined) world.absenceMs = Math.max(0, world.now - s.journal.lastHumanAt);
    if (generation !== s.runtime.generation || s.applied?.soul !== name || signal?.aborted) return;
    const said = await perceive($, options, s.runtime, generation, name, moment, world, signal);
    if (!said || generation !== s.runtime.generation || s.applied?.soul !== name || signal?.aborted) return;
    // Tool context waits until the whole batch's results are kept; never split tool pairs.
    if (moment.kind === "tool") s.toolNotes.push({ text: said.text, generation });
    else await reminder($, s, said.text);
  } catch {
    // Discovery, world facts and executable perceptions fail independently of the host.
  }
}

export function retainedMessages(before: readonly SessionMessage[], after: readonly SessionMessage[], handles: readonly string[]): readonly SessionMessage[] {
  const wanted = new Set([...handles, ...after.flatMap((message) => message.handle ? [message.handle] : [])]);
  const ids = new Set<string>();
  const toolIds = (message: SessionMessage) => [...message.toolUses, ...(message.toolResults ?? [])].map((tool) => tool.tool_use_id);
  for (const message of after) for (const id of toolIds(message)) ids.add(id);
  // A carrier can be a tool-result row, or an assistant with several calls.
  // Retain the entire connected batch, not intervening unrelated messages.
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of before) {
      const tools = toolIds(message);
      if (!message.handle || (!wanted.has(message.handle) && !tools.some((id) => ids.has(id)))) continue;
      if (!wanted.has(message.handle)) { wanted.add(message.handle); changed = true; }
      for (const id of tools) if (!ids.has(id)) { ids.add(id); changed = true; }
    }
  }
  const positions = new Map(before.map((message, index) => [message.handle, index]));
  const result = [...after];
  for (const [index, message] of before.entries()) {
    if (!message.handle || !wanted.has(message.handle) || result.some((item) => item.handle === message.handle)) continue;
    const later = result.findIndex((item) => item.handle !== undefined && (positions.get(item.handle) ?? -1) > index);
    // Native synthetic summary stays first. Old carriers go before newer native
    // retained messages, or just after the last original (before new tail rows).
    const lastOriginal = result.findLastIndex((item) => item.handle !== undefined && positions.has(item.handle));
    result.splice(later >= 0 ? later : lastOriginal >= 0 ? lastOriginal + 1 : Math.min(1, result.length), 0, message);
  }
  return result;
}

export function register(on: On, options: PluginOptions = {}) {
  const s: State = {
    journal: { known: false }, choice: DEFAULTS, choiceKnown: false, seeding: false,
    proposals: new Map(), runtime: createPerceptionRuntime(), toolNotes: [], reported: new Set(), suppression: "send a message to see the active soul",
  };
  on("classic.SessionStart", async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e);
    const same = s.sessionId === e.session_id;
    if (!same || e.source !== "compact") await stopRuntime($, s.runtime);
    else invalidateRuntime(s.runtime);
    s.sessionId = e.session_id; s.transcriptPath = e.transcript_path;
    if (!same || e.source !== "compact") {
      s.head = undefined; s.journalHead = undefined; s.journal = { known: false };
      s.choiceKnown = e.source === "startup" || e.source === "clear";
      s.choice = DEFAULTS; s.proposals.clear(); s.applied = undefined; s.observed = undefined;
      s.native = undefined; s.compactedOpening = undefined; s.sectionIdentity = undefined;
      s.human = undefined; s.pendingBrain = undefined; s.pendingChoice = undefined; s.toolNotes = []; s.reported.clear();
    } else s.compactedOpening = s.journal.snapshot?.systemPrompt[0];
    s.pendingChoice = undefined;
    s.wake = { kind: "wake", source: e.source };
    return next(e);
  });
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    status($, s);
    await $.command.register({ name: "soul", description: "Soul: status, @name, clear, reset or reload", argumentHint: "[@name|clear|reset|reload]" });
    // Detached preview sends nothing; the session slot is unmodified while seeding.
    s.seeding = true;
    try { await $.prompt.compose(); } finally { s.seeding = false; invalidate($); }
    return result;
  });
  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined || e.door === "queue" || result.uuid === undefined) return result;
    s.head = result.uuid;
    const pending = s.pendingChoice;
    if (pending && e.door === "command") {
      const text = result.message.content.map((block) => block.type === "text" ? block.text : "").join("");
      const echo = result.message.type === "user" && !result.message.isMeta
        ? /^<command-name>\/soul<\/command-name>\s*<command-message>soul<\/command-message>\s*<command-args>([\s\S]*)<\/command-args>$/.exec(text)
        : undefined;
      if (echo?.[1] === pending.args) {
        s.pendingChoice = undefined;
        // The kept native echo is the command's rewind coordinate. Commit AFTER it.
        if (await append($, s, "system", encodeChoice(pending.choice))) {
          invalidateRuntime(s.runtime);
          s.choice = pending.choice; s.choiceKnown = true; invalidate($);
        }
      } else if (result.message.type === "system" && result.message.name === "local_command") {
        s.pendingChoice = undefined;
        warn($, s, "Soul selection could not be saved. Try /soul again.");
      }
    }
    return result;
  });
  on("prompt.section", { name: ["pronouns", "session_guidance"] }, async ($, e, next) => {
    const result = await next(e);
    const native = s.native;
    if (s.seeding || !native) return result;
    try { await hydrate($, s, options); } catch (error) { warn($, s, error); return result; }
    const slot = identitySlot(s);
    if (slot === undefined || e.name !== slot) return result;
    let body = native.body, name: string | undefined, icon: string | undefined;
    try {
      const model = s.renderModel ?? await $.session.model();
      name = await selected($, s, options, model);
      if (name) { const content = await load($, options, name, model); body = content.body; icon = content.icon; }
    } catch (error) { warn($, s, error); name = undefined; }
    s.sectionIdentity = { slot, soul: name ?? null, ...(icon ? { icon } : {}) };
    const prefix = slot === PRONOUNS ? native.raw.replace(native.body, () => body) : body;
    return { ...result, text: prefix + (result.text ? `\n\n${result.text}` : ""), breakPromptCache: true };
  });
  on("prompt.compose", async ($, e, next) => {
    if (!s.seeding) {
      try { await hydrate($, s, options, undefined, true); } catch (error) { warn($, s, error); }
    }
    s.renderModel = e.model;
    const result = await next(e);
    const target = result.sections.find((item) => item.id === (e.traits.includes("lean") ? "lean_body" : "intro"));
    const opening = target && openingParagraph(target.text);
    if (!target || !opening) { if (!s.seeding) warn($, s, "Could not apply the soul to Claude’s system prompt. The current prompt was left unchanged."); return result; }
    if (s.seeding || !s.native) {
      const following = result.sections[1];
      // Fold only across the actual join between a sole shared opening and
      // an adjacent session section; moving just the identity changes order.
      const adjacent = result.sections[0] === target && target.scope === "shared"
        && following?.id === PRONOUNS && following.scope === "session" && following.text;
      const suffix = target.text.slice(target.text.indexOf(opening.body) + opening.body.length);
      s.native = { ...opening, raw: target.text, ...(adjacent ? { foldedTail: `${suffix}\n\n${following.text}` } : {}) };
      return result;
    }
    const identity = s.sectionIdentity;
    const slot = identity && result.sections.find((item) => item.id === identity.slot);
    if (!identity || !slot || identity.slot !== identitySlot(s)) return result;
    const sections = identity.slot === PRONOUNS
      ? result.sections.filter((item) => item !== target)
      : result.sections.map((item): PromptComposeSection => item === target ? { ...item, text: opening.rest } : item);
    const first = sections.find((item) => item.text !== "")?.text;
    if (first !== undefined) {
      s.proposals.delete(slot.text);
      s.proposals.set(slot.text, { soul: identity.soul, icon: identity.icon, section: slot.text, opening: first });
      if (s.proposals.size > 8) s.proposals.delete(s.proposals.keys().next().value!);
    }
    return { ...result, sections };
  });
  on("command.run", { command: "soul" }, async ($, e) => {
    s.pendingChoice = undefined;
    try {
      await hydrate($, s, options);
      const model = await $.session.model(), input = e.args.trim();
      if (!input) {
        await preview($, model); prove($, s);
        const available = await files<{ dir: string; names: string[] }>($, options, { op: "list" });
        const name = await selected($, s, options, model);
        return { text: [
          `Soul choice: ${s.choiceKnown ? s.choice.mode === "named" ? `@${s.choice.name}` : s.choice.mode : "send a message to restore this session’s selection"}`,
          `Active: ${s.applied ? s.applied.soul ?? "none" : `unconfirmed (${s.suppression})`}`,
          `Configured: ${name ?? "none"}`, `Souls: ${available.names.map((n) => `@${n}`).join(", ") || "none"}`, `Dir: ${available.dir}`,
        ].join("\n") };
      }
      if (input === "reload") {
        const name = await selected($, s, options, model);
        if (!name) return { text: "No soul to reload." };
        const content = await load($, options, name, model);
        await reloadRuntime($, s.runtime, await $.session.id(), `${content.dir}/${name}`);
        invalidate($);
        return { text: `Reloaded @${name}. Updated content will be used on your next message.` };
      }
      let target: SoulChoice;
      if (input === "clear") target = { mode: "disabled" };
      else if (input === "reset") target = DEFAULTS;
      else if (input.startsWith("@") && isSoulName(input.slice(1))) {
        target = { mode: "named", name: input.slice(1) };
        await load($, options, target.name, model);
      } else return { text: "Usage: /soul [@name|clear|reset|reload]", exitCode: 1 };
      if (target.mode === "defaults") {
        const name = await selected($, s, options, model, target, true);
        if (name) await load($, options, name, model);
      }
      if (s.choiceKnown && encodeChoice(s.choice) === encodeChoice(target)) {
        invalidate($); return { text: target.mode === "disabled" ? "Souls are already set to turn off. Use /soul to check the active identity." : target.mode === "defaults" ? "Already following your default soul settings." : `@${target.name} is already selected.` };
      }
      s.pendingChoice = { choice: target, args: e.args };
      return { text: target.mode === "disabled" ? "Turning off souls for your next message." : target.mode === "defaults" ? "Restoring your default soul settings for the next message." : `Switching to @${target.name} for your next message.` };
    } catch (error) { return { text: `Soul: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }; }
    finally { invalidate($); }
  });
  on("prompt.autocomplete", async ($, e, next) => {
    const result = await next(e);
    if (!/^\/soul\s+$/.test(e.text.slice(0, e.start))) return result;
    try {
      const { names } = await files<{ names: string[] }>($, options, { op: "list" });
      const items = [...names.map((name) => `@${name}`), "clear", "reset", "reload"];
      return { suggestions: [...result.suggestions, ...items.filter((text) => text.startsWith(e.token)).map((text) => ({ text }))] };
    } catch (error) { warn($, s, error); return result; }
  });
  on("prompt.submit", async ($, e, next) => {
    if (e.command || e.isMeta) return next(e);
    s.pendingChoice = undefined;
    try { await hydrate($, s, options); } catch (error) { warn($, s, error); }
    const pending = { text: e.text, now: await $.clock.now(), previousHumanAt: s.journal.lastHumanAt };
    const result = await next(e);
    if (result.drop === undefined) s.human = pending;
    return result;
  });
  on("classic.PostModelSwitch", async ($, e, next) => {
    const result = await next(e);
    invalidateRuntime(s.runtime);
    invalidate($);
    if (e.source !== "resume" && e.from_model !== e.to_model) s.pendingBrain = e.to_model;
    return result;
  });
  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);
    try {
      await hydrate($, s, options);
      await preview($, e.model);
      const actual = prove($, s);
      const generation = s.runtime.generation;
      if (s.choiceKnown && s.choice.mode === "disabled" && actual?.soul) {
        warn($, s, `Claude is still using @${actual.soul}; turning off souls did not take effect. Start a new session, or use /soul reset if its default is a different soul.`);
      }
      for (const note of s.toolNotes.splice(0)) {
        if (note.generation === s.runtime.generation && !next.signal?.aborted) await reminder($, s, note.text);
      }
      if (s.pendingBrain && s.journal.model !== s.pendingBrain) {
        if (await reminder($, s, `new brain: ${s.pendingBrain}`)) s.pendingBrain = undefined;
      }
      if (actual && generation === s.runtime.generation && s.applied?.soul === actual.soul && !next.signal.aborted) {
        const previous = s.journal.soul === undefined ? s.observed : s.journal.soul;
        let delivered = true;
        if (previous !== undefined && previous !== actual.soul && actual.soul !== null) delivered = await reminder($, s, `new soul: ${actual.soul}`);
        // A denied cue must not be consumed by a successful human divider.
        if (delivered && previous !== actual.soul && (previous !== undefined || actual.soul !== null)) {
          delivered = await append($, s, "system", actual.soul ? `── soul: ${actual.soul} ──` : "── soulless ──");
        }
        if (delivered) s.observed = actual.soul;
        if (actual.soul) {
          if (s.wake) { const moment = s.wake; s.wake = undefined; await perceiveActive($, s, options, moment, undefined, undefined, next.signal); }
          if (e.index === 0 && s.human && generation === s.runtime.generation && s.applied?.soul === actual.soul && !next.signal.aborted) {
            const pending = s.human; s.human = undefined;
            const previousAt = pending.previousHumanAt ?? (s.journal.lastHumanAt !== undefined && s.journal.lastHumanAt < pending.now ? s.journal.lastHumanAt : s.journal.previousHumanAt);
            const absenceMs = previousAt === undefined ? undefined : Math.max(0, pending.now - previousAt);
            const world = await worldFor($, actual.soul, absenceMs, pending.now);
            if (options.timeaware !== false) {
              const said = await timePerception(s.journal.noteAt)({ kind: "human", text: pending.text }, world);
              if (said && generation === s.runtime.generation && s.applied?.soul === actual.soul && !next.signal.aborted) await reminder($, s, said.text);
            }
            if (generation === s.runtime.generation && s.applied?.soul === actual.soul && !next.signal.aborted) {
              await perceiveActive($, s, options, { kind: "human", text: pending.text }, absenceMs, pending.now, next.signal);
            }
          }
        }
      }
    } catch (error) { invalidateRuntime(s.runtime); s.applied = undefined; status($, s); warn($, s, error); }
    const result = yield* next(e);
    invalidate($);
    return result;
  });
  on("classic.PreToolUse", async ($, e, next) => {
    const result = await next(e);
    if (e.agent_id === undefined) {
      const args = Object.fromEntries(Object.entries(e).filter(([key]) => !ENVELOPE.has(key)));
      await perceiveActive($, s, options, toolMoment(e.tool, "before", args), undefined, undefined, next.signal);
    }
    return result;
  });
  on("classic.PostToolUse", async ($, e, next) => {
    const result = await next(e);
    if (e.agent_id === undefined) await perceiveActive($, s, options, toolMoment(e.tool_name, "after", e.tool_input, e.tool_response, true), undefined, undefined, next.signal);
    return result;
  });
  on("classic.PostToolUseFailure", async ($, e, next) => {
    const result = await next(e);
    if (e.agent_id === undefined) await perceiveActive($, s, options, toolMoment(e.tool_name, "after", e.tool_input, e.error, false), undefined, undefined, next.signal);
    return result;
  });
  on("session.compact", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    await hydrate($, s, options, e.messages.flatMap((message) => message.handle ? [message.handle] : []));
    const handles = s.journal.retainHandles ?? [];
    const result = await next(e);
    if (result.skip !== undefined) return result;
    // Unchanged native handles retain their trailing notices/attachments/meta rows too.
    return { ...result, messages: retainedMessages(e.messages, result.messages, handles) };
  });
  on("session.end", async ($, e, next) => {
    await stopRuntime($, s.runtime);
    s.pendingChoice = undefined; s.toolNotes = []; s.applied = undefined; status($, s);
    return next(e);
  });
}
