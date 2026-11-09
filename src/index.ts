import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { applySoul, replaceForcedPreamble } from "./prompt.ts";
import { footerText, resolvePresence, resolvePerception, selectionPresence, type Presence } from "./presence.ts";
import { ENTRY_TYPE, effectiveSoul, isSoulName, lastTimeNoteTimestamp, lastUserMessageTimestamp, listSouls, readConfig, readSoul, resolveSoul, sessionSoul, unmatchableModelKeys, type Selection, type SoulVariables } from "./souls.ts";
import { timePerception } from "./time.ts";
import { TRANSITION_ENTRY_TYPE, TRANSITION_MESSAGE_TYPE, readTransition, sameTransition, type Transition } from "./transitions.ts";
import { appendDivider, registerPresenceUI, setFooter } from "./ui.ts";
import { loadPerception, sendReminder, toolCategory, toolFilePath, toolText, worldFor, type Moment, type Perception } from "./perception.ts";

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
const soulVariables = (ctx: ExtensionContext): SoulVariables => ({
  model: { provider: ctx.model?.provider ?? "", id: ctx.model?.id ?? "" },
  cwd: ctx.cwd,
});
/** `new` starts a fresh session (a clear); `reload` re-loads the extension, not the session. */
const wakeSource = (reason: string): Extract<Moment, { kind: "wake" }>["source"] | undefined => {
  if (reason === "new") return "clear";
  if (reason === "startup" || reason === "resume" || reason === "fork") return reason;
  return undefined;
};

function describe(selection: Selection | undefined, model: ExtensionContext["model"], suppressed = false, soulless = false): string {
  if (!selection) return soulless ? "none (soulless)" : suppressed ? "none (custom prompt)" : "none";
  if (selection.source === "model") return `${selection.name} (${model?.provider}/${model?.id})`;
  return `${selection.name} (${selection.source})`;
}

export default function soulsExtension(pi: ExtensionAPI) {
  registerPresenceUI(pi);
  pi.registerFlag("soulless", { description: "Skip default souls (session /soul still wins)", type: "boolean", default: false });
  const soulless = () => pi.getFlag("soulless") === true || /^(1|true)$/i.test(process.env.SOULLESS ?? "");
  // Argument completion has no context; remember where the session runs for relative soulsDir.
  let cwd = process.cwd();
  // A problem is reported when it appears or changes, not on every request of a tool loop.
  let reported: string | undefined;
  // Hold live options: handlers after ours can still set customPrompt or forceSystemPrompt.
  let options: BuildSystemPromptOptions | undefined;
  let running = false;
  // What the projection handler learned for this request, read by the transition handler.
  let projection: { known: boolean; soul: string | null } | undefined;
  let forceReported = false;
  // ExtensionContext has no system-prompt options before a run or command; track what the host told us.
  let promptKnown = false;
  let seenPrompt: string | undefined;
  // Cache one perception per soul directory, including which extension supplied it.
  const perceptions = new Map<string, { path: string; perception: Perception }>();
  const perceptionFor = (path: string): Perception => {
    const dir = dirname(path);
    let cached = perceptions.get(dir);
    if (!cached || cached.path !== path) {
      cached = { path, perception: loadPerception(path) };
      perceptions.set(dir, cached);
    }
    return cached.perception;
  };
  // Tool calls remember what the end event no longer carries, bounded so a long run cannot grow it.
  const toolCalls = new Map<string, { filePath?: string; input?: string }>();
  const absence = (branch: readonly SessionEntry[], now: number): number | undefined => {
    const last = lastUserMessageTimestamp(branch);
    return last === undefined ? undefined : Math.max(0, now - last);
  };
  /** Builtin and directory perceptions answer independently; failures never break the host. */
  const perceive = async (moment: Moment, ctx: ExtensionContext, customPrompt: string | undefined): Promise<void> => {
    try {
      const config = readConfig(pi.getSettings(), ctx.cwd);
      const branch = ctx.sessionManager.getBranch();
      const selection = effectiveSoul(resolveSoul(config, sessionSoul(branch), ctx.model, soulless()), customPrompt);
      if (!selection) return;
      const now = Date.now();
      const world = worldFor({ now, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, soul: selection.name, absenceMs: absence(branch, now) });
      if (config.timeaware && moment.kind === "human") {
        try {
          readSoul(config.dir, selection.name, soulVariables(ctx));
          const said = await timePerception(lastTimeNoteTimestamp(branch))(moment, world);
          if (said && typeof said.text === "string" && said.text.trim()) {
            sendReminder(pi, { text: said.text, details: { moment: moment.kind, timestamp: now } });
          }
        } catch {
          // A missing or unreadable soul has no builtin time perception.
        }
      }
      const target = resolvePerception(config, selection);
      if (target) {
        try {
          const said = await perceptionFor(target.path)(moment, world);
          if (said && typeof said.text === "string" && said.text.trim()) {
            sendReminder(pi, { text: said.text, details: { moment: moment.kind } });
          }
        } catch {
          // A directory perception is independent of the builtin time perception.
        }
      }
    } catch {
      // A perception is decoration: a broken configuration never breaks the host.
    }
  };
  // Retain the original text so tool-loop requests and soul edits do not patch our own output.
  let forcedProjection: { original: string; projected: string; body: string; basePreamble?: string } | undefined;
  // A failed render must not leave an earlier soul in a forced prompt another handler rebuilt.
  const restoreForcedProjection = (): void => {
    if (!running || !forcedProjection || !options || options.forceSystemPrompt === undefined) return;
    if (options.forceSystemPrompt === forcedProjection.projected) {
      options.forceSystemPrompt = forcedProjection.original;
      return;
    }
    // The forced prompt may have been rebuilt from the projected text: put the base identity back.
    if (forcedProjection.basePreamble !== undefined && options.forceSystemPrompt.includes(forcedProjection.body)) {
      options.forceSystemPrompt = options.forceSystemPrompt.replace(forcedProjection.body, () => forcedProjection!.basePreamble!);
    }
  };
  const presenceFor = (ctx: ExtensionContext, customPrompt: string | undefined, model = ctx.model) =>
    resolvePresence(readConfig(pi.getSettings(), ctx.cwd), ctx.sessionManager.getBranch(), model, customPrompt, soulless(), soulVariables(ctx));
  const promptValue = () => (options ? options.customPrompt : seenPrompt);
  const refreshFooter = (ctx: ExtensionContext, customPrompt: string | undefined, model = ctx.model, known = promptKnown): void => {
    try {
      const config = readConfig(pi.getSettings(), ctx.cwd);
      const selection = resolveSoul(config, sessionSoul(ctx.sessionManager.getBranch()), model, soulless());
      // Before the host reports prompt options, only a session choice is provably effective.
      if (!known && selection && selection.source !== "session") {
        setFooter(ctx, undefined);
        return;
      }
      setFooter(ctx, footerText(selectionPresence(config, effectiveSoul(selection, customPrompt), soulVariables(ctx))));
    } catch {
      setFooter(ctx, undefined);
    }
  };
  pi.on("session_start", (event, ctx) => {
    cwd = ctx.cwd; reported = undefined; forceReported = false;
    options = undefined; running = false;
    projection = undefined; forcedProjection = undefined;
    promptKnown = false; seenPrompt = undefined;
    toolCalls.clear();
    refreshFooter(ctx, undefined, ctx.model, false);
    const source = wakeSource(event.reason);
    if (source) return perceive({ kind: "wake", source }, ctx, undefined);
  });
  pi.on("session_compact", (_event, ctx) => perceive({ kind: "wake", source: "compact" }, ctx, options?.customPrompt));
  pi.on("model_select", (event, ctx) => {
    refreshFooter(ctx, promptValue(), event.model);
    if (!event.previousModel || (event.previousModel.provider === event.model.provider && event.previousModel.id === event.model.id)) return;
    sendReminder(pi, {
      customType: TRANSITION_MESSAGE_TYPE, display: false, defer: true,
      text: `new brain: ${event.model.id}`,
      details: { version: 1, model: { provider: event.model.provider, id: event.model.id } },
    });
  });
  pi.on("session_tree", (_event, ctx) => refreshFooter(ctx, promptValue()));
  pi.on("before_agent_start", (event, ctx) => {
    options = event.systemPromptOptions; running = true; forcedProjection = undefined;
    seenPrompt = options.customPrompt; promptKnown = true;
    refreshFooter(ctx, options.customPrompt);
    if ("messageType" in event && event.messageType !== "user") return;
    // The handler stays synchronous: a pending perception answer arrives when it arrives.
    void perceive({ kind: "human", text: event.prompt }, ctx, options.customPrompt);
  });
  pi.on("agent_settled", () => {
    running = false; projection = undefined;
  });
  pi.on("tool_call", (event, ctx) => {
    const filePath = toolFilePath(event.input);
    const input = toolText(event.input);
    const record = { ...(filePath ? { filePath } : {}), ...(input ? { input } : {}) };
    toolCalls.delete(event.toolCallId);
    toolCalls.set(event.toolCallId, record);
    if (toolCalls.size > 64) toolCalls.delete(toolCalls.keys().next().value!);
    return perceive({ kind: "tool", phase: "before", category: toolCategory(event.toolName), toolName: event.toolName, ...record }, ctx, options?.customPrompt);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const record = toolCalls.get(event.toolCallId);
    toolCalls.delete(event.toolCallId);
    const output = toolText(event.result);
    return perceive({ kind: "tool", phase: "after", category: toolCategory(event.toolName), toolName: event.toolName, ...record, ...(output ? { output } : {}), ok: !event.isError }, ctx, options?.customPrompt);
  });
  // The host copies the run options before each tool-loop request, so re-render them here:
  // a broken soul falls back to the base prompt instead of stalling the previous body.
  pi.on("turn_end", (_event, ctx) => {
    const previous = forcedProjection;
    if (!running || !previous || !options || options.forceSystemPrompt === undefined) return;
    const basePreamble = previous.basePreamble;
    try {
      const config = readConfig(pi.getSettings(), ctx.cwd);
      const selection = effectiveSoul(resolveSoul(config, sessionSoul(ctx.sessionManager.getBranch()), ctx.model, soulless()), options.customPrompt);
      if (!selection || basePreamble === undefined) {
        options.forceSystemPrompt = previous.original;
        return;
      }
      const body = readSoul(config.dir, selection.name, soulVariables(ctx)).body;
      const projected = previous.original.includes(basePreamble) ? previous.original.replace(basePreamble, () => body) : previous.original;
      options.forceSystemPrompt = projected;
      forcedProjection = { original: previous.original, projected, body, basePreamble };
    } catch {
      // The next request re-renders; keep the fallback until the file works again.
      options.forceSystemPrompt = previous.original;
    }
  });

  pi.registerCommand("soul", {
    description: "Soul: /soul [@name|clear|reset|reload]",
    getArgumentCompletions: (prefix) => {
      try {
        const souls = listSouls(readConfig(pi.getSettings(), cwd).dir).map((name) => ({ value: `@${name}`, label: `@${name}` }));
        const items = [
          ...souls,
          { value: "clear", label: "clear", description: "Disable souls for this session" },
          { value: "reset", label: "reset", description: "Follow defaults again" },
          { value: "reload", label: "reload", description: "Re-read the active soul and perception" },
        ];
        const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
        return matches.length ? matches : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const notify = (text: string) => ctx.ui.notify(text, "info");
      if (!ctx.isIdle()) {
        ctx.ui.notify("Busy. Try again after this run.", "warning");
        return;
      }
      try {
        const input = args.trim();
        const config = readConfig(pi.getSettings(), ctx.cwd);
        const prompt = ctx.getSystemPromptOptions().customPrompt;
        seenPrompt = prompt; promptKnown = true;
        const override = () => sessionSoul(ctx.sessionManager.getBranch());
        const resolved = () => resolveSoul(config, override(), ctx.model, soulless());
        const active = () => effectiveSoul(resolved(), prompt);
        const activeName = () => {
          try {
            return active()?.name;
          } catch {
            return undefined;
          }
        };
        const loadedName = (name: string | undefined) => {
          if (!name) return undefined;
          try {
            readSoul(config.dir, name, soulVariables(ctx));
            return name;
          } catch {
            return undefined;
          }
        };
        const refresh = () => refreshFooter(ctx, prompt);
        const now = () => {
          const configured = resolved();
          const selection = effectiveSoul(configured, prompt);
          return describe(selection, ctx.model, selection === undefined && configured !== undefined, soulless() || override() === null);
        };

        if (input === "clear" || input === "reset") {
          const target = input === "clear" ? null : undefined;
          let unchanged = false;
          try {
            unchanged = override() === target;
          } catch {
            // Either command can repair a damaged choice.
          }
          if (unchanged) {
            refresh();
            return notify(`${input === "clear" ? "Already soulless" : "Already following defaults"}. Soul: ${now()}`);
          }
          const before = loadedName(activeName());
          pi.appendEntry(ENTRY_TYPE, { version: 1, name: null, ...(input === "clear" ? { disabled: true } : {}) });
          const after = loadedName(active()?.name);
          if (before !== after) appendDivider(pi, after ?? null);
          refresh();
          return notify(`${input === "clear" ? "Cleared" : "Reset"}. Soul: ${now()}`);
        }

        if (input === "reload") {
          const selection = active();
          if (!selection) {
            refresh();
            return notify("No soul to reload.");
          }
          readSoul(config.dir, selection.name, soulVariables(ctx)); // A broken SOUL or fragment never clears the old module.
          perceptions.delete(join(config.dir, selection.name));
          refresh();
          return notify(`Reloaded ${selection.name}.`);
        }

        if (!input) {
          refresh();
          const available = listSouls(config.dir);
          const configured = resolved();
          const selection = effectiveSoul(configured, prompt);
          const missing = selection && !available.includes(selection.name) ? " (missing)" : "";
          const ignored = unmatchableModelKeys(config);
          return notify([
            `Soul: ${describe(selection, ctx.model, selection === undefined && configured !== undefined, soulless() || override() === null)}${missing}`,
            `Souls: ${available.map((name) => `@${name}`).join(", ") || "none"}`,
            `Dir: ${tilde(config.dir)}`,
            ...(ignored.length ? [`Ignored keys: ${ignored.join(", ")}`] : []),
          ].join("\n"));
        }

        if (!input.startsWith("@") || !isSoulName(input.slice(1))) {
          ctx.ui.notify("Usage: /soul [@<name>|clear|reset|reload]", "warning");
          return;
        }

        const name = input.slice(1);
        if (override() === name) {
          refresh();
          return notify(`Already ${name}.`);
        }
        const available = listSouls(config.dir);
        if (!available.includes(name)) {
          throw new Error(`No soul "${name}". Souls: ${available.map((name) => `@${name}`).join(", ") || "none"}`);
        }
        readSoul(config.dir, name, soulVariables(ctx)); // Validate content before changing durable session state.
        const before = loadedName(activeName());
        pi.appendEntry(ENTRY_TYPE, { version: 1, name });
        if (before !== name) appendDivider(pi, name);
        refresh();
        return notify(`Soul: ${name}`);
      } catch (error) {
        refreshFooter(ctx, ctx.getSystemPromptOptions().customPrompt);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const project = (messages: AgentMessage[], body: string, ctx: ExtensionContext): AgentMessage[] => {
    const base = messages.findLast((message): message is Extract<AgentMessage, { role: "system" }> => message.role === "system" && typeof message.sections?.preamble === "string");
    const basePreamble = base?.sections?.preamble ?? undefined;
    const projected = applySoul(messages, body);
    // Pi projects forced text after this hook; patch that too, not just its transcript sections.
    if (running && options?.forceSystemPrompt !== undefined) {
      const forced = options.forceSystemPrompt;
      const original = forced === forcedProjection?.projected ? forcedProjection.original : forced;
      const patched = replaceForcedPreamble(messages, original, body);
      forcedProjection = { original, projected: patched, body, basePreamble };
      options.forceSystemPrompt = patched;
      if (!forceReported) {
        const notice = "Soul: preamble replaced";
        if (ctx.hasUI) ctx.ui.notify(notice, "info");
        else console.warn(notice);
        forceReported = true;
      }
    } else {
      forceReported = false;
    }
    return projected;
  };

  const report = (error: unknown, ctx: ExtensionContext): void => {
    // The request goes out with Pi's own prompt; an unchanged problem skips quietly.
    const problem = error instanceof Error ? error.message : String(error);
    if (problem === reported) return;
    reported = problem;
    // Without a UI (print mode), only a thrown error reaches the user, on stderr.
    if (!ctx.hasUI) throw error;
    ctx.ui.notify(problem, "warning");
  };

  // The request boundary sees the final live options, after every before_agent_start handler.
  const recordTransition = (ctx: ExtensionContext, soul: string | null | undefined): void => {
    const branch = ctx.sessionManager.getBranch();
    const previous = readTransition(branch);
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    const current: Transition = { model, soul: soul === undefined ? previous?.soul ?? null : soul };
    if (previous && sameTransition(previous, current)) return;
    pi.appendEntry(TRANSITION_ENTRY_TYPE, { version: 1, ...current });
    if (previous && previous.soul !== current.soul && current.soul) {
      sendReminder(pi, {
        customType: TRANSITION_MESSAGE_TYPE, display: false, defer: true,
        text: `new soul: ${current.soul}`, details: { version: 1, soul: current.soul },
      });
    }
  };

  // First handler owns presence/projection and its existing error path, including the no-UI throw.
  pi.on("context_with_system", (event, ctx) => {
    if (options) {
      seenPrompt = options.customPrompt; promptKnown = true;
    }
    projection = undefined;
    let presence: Presence | undefined;
    try {
      presence = presenceFor(ctx, options?.customPrompt);
    } catch (error) {
      restoreForcedProjection();
      projection = { known: false, soul: null };
      setFooter(ctx, undefined);
      return report(error, ctx);
    }
    if (!presence) {
      projection = { known: true, soul: null };
      setFooter(ctx, undefined);
      reported = undefined;
      return;
    }
    try {
      const messages = project(event.messages, presence.body, ctx);
      projection = { known: true, soul: presence.selection.name };
      setFooter(ctx, footerText(presence));
      reported = undefined;
      return messages && { messages };
    } catch (error) {
      // A failed re-render must not leave a previous soul in the forced prompt.
      restoreForcedProjection();
      projection = { known: false, soul: null };
      setFooter(ctx, undefined);
      report(error, ctx);
    }
  });

  // A separate handler still runs after the runner catches a projection throw.
  pi.on("context_with_system", (event, ctx) => {
    // Only successful projection confirms a soul. Delivery is persisted by Pi at
    // the next safe boundary, never retroactively inserted into a sent request.
    if (running) recordTransition(ctx, projection?.known ? projection.soul : undefined);
    return { messages: event.messages };
  });
}
