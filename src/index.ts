import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySoul, replaceForcedPreamble } from "./prompt.ts";
import { footerText, resolvePresence, selectionPresence, type Presence } from "./presence.ts";
import { ENTRY_TYPE, effectiveSoul, listSouls, readConfig, readSoul, resolveSoul, sessionSoul, unmatchableModelKeys, type Selection } from "./souls.ts";
import { TRANSITION_ENTRY_TYPE, TRANSITION_MESSAGE_TYPE, formatTransitionReminder, readTransition, sameTransition, transitionLines, type Transition } from "./transitions.ts";
import { appendDivider, registerPresenceUI, setFooter } from "./ui.ts";

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

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
  let userRun = false;
  let transitionComputed = false;
  let pendingReminder: string | undefined;
  // What the projection handler learned for this request, read by the transition handler.
  let projection: { known: boolean; soul: string | null } | undefined;
  let forceReported = false;
  // ExtensionContext has no system-prompt options before a run or command; track what the host told us.
  let promptKnown = false;
  let seenPrompt: string | undefined;
  // Retain the original text so tool-loop requests and soul edits do not patch our own output.
  let forcedProjection: { original: string; projected: string } | undefined;
  const presenceFor = (ctx: ExtensionContext, customPrompt: string | undefined, model = ctx.model) =>
    resolvePresence(readConfig(pi.getSettings(), ctx.cwd), ctx.sessionManager.getBranch(), model, customPrompt, soulless());
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
      setFooter(ctx, footerText(selectionPresence(config, effectiveSoul(selection, customPrompt))));
    } catch {
      setFooter(ctx, undefined);
    }
  };
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd; reported = undefined; forceReported = false;
    options = undefined; running = false; userRun = false; transitionComputed = false; pendingReminder = undefined;
    projection = undefined; forcedProjection = undefined;
    promptKnown = false; seenPrompt = undefined;
    refreshFooter(ctx, undefined, ctx.model, false);
  });
  pi.on("model_select", (event, ctx) => refreshFooter(ctx, promptValue(), event.model));
  pi.on("session_tree", (_event, ctx) => refreshFooter(ctx, promptValue()));
  pi.on("before_agent_start", (event, ctx) => {
    options = event.systemPromptOptions; running = true; forcedProjection = undefined;
    userRun = !("messageType" in event) || event.messageType === "user";
    transitionComputed = false; pendingReminder = undefined;
    seenPrompt = options.customPrompt; promptKnown = true;
    refreshFooter(ctx, options.customPrompt);
  });
  pi.on("agent_settled", () => {
    running = false; userRun = false; transitionComputed = false; pendingReminder = undefined; projection = undefined;
  });

  pi.registerCommand("soul", {
    description: "Switch soul: /soul [name|clear]",
    getArgumentCompletions: (prefix) => {
      try {
        const souls = listSouls(readConfig(pi.getSettings(), cwd).dir).map((name) => ({ value: name, label: name }));
        const items = [...souls, { value: "clear", label: "clear", description: "Follow defaults" }];
        const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
        return matches.length ? matches : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const notify = (text: string) => ctx.ui.notify(text, "info");
      if (!ctx.isIdle()) {
        ctx.ui.notify("Busy. Switch souls after this run.", "warning");
        return;
      }
      try {
        const name = args.trim();
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
            readSoul(config.dir, name);
            return name;
          } catch {
            return undefined;
          }
        };
        const refresh = () => refreshFooter(ctx, prompt);
        const now = () => {
          const configured = resolved();
          const selection = effectiveSoul(configured, prompt);
          return describe(selection, ctx.model, selection === undefined && configured !== undefined, soulless());
        };

        if (name === "clear") {
          let selected = true; // A corrupted selection counts as something to clear.
          try {
            selected = override() !== undefined;
          } catch {
            // Keep clearing the damaged choice.
          }
          if (!selected) {
            refresh();
            return notify(`No session soul. Soul: ${now()}`);
          }
          const before = loadedName(activeName());
          pi.appendEntry(ENTRY_TYPE, { version: 1, name: null });
          const after = loadedName(active()?.name);
          if (before !== after) appendDivider(pi, after ?? null);
          refresh();
          return notify(`Cleared. Soul: ${now()}`);
        }

        const available = listSouls(config.dir);
        if (name) {
          if (override() === name) {
            refresh();
            return notify(`Already ${name}.`);
          }
          if (!available.includes(name)) {
            throw new Error(`No soul "${name}". Souls: ${available.join(", ") || "none"}`);
          }
          readSoul(config.dir, name); // Validate content before changing durable session state.
          const before = loadedName(activeName());
          pi.appendEntry(ENTRY_TYPE, { version: 1, name });
          if (before !== name) appendDivider(pi, name);
          refresh();
          return notify(`Soul: ${name}`);
        }

        refresh();
        const configured = resolved();
        const selection = effectiveSoul(configured, prompt);
        const missing = selection && !available.includes(selection.name) ? " (missing)" : "";
        const ignored = unmatchableModelKeys(config);
        notify([
          `Soul: ${describe(selection, ctx.model, selection === undefined && configured !== undefined, soulless())}${missing}`,
          `Souls: ${available.join(", ") || "none"}`,
          `Dir: ${tilde(config.dir)}`,
          ...(ignored.length ? [`Ignored keys: ${ignored.join(", ")}`] : []),
        ].join("\n"));
      } catch (error) {
        refreshFooter(ctx, ctx.getSystemPromptOptions().customPrompt);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const project = (messages: AgentMessage[], body: string, ctx: ExtensionContext): AgentMessage[] => {
    const projected = applySoul(messages, body);
    // Pi projects forced text after this hook; patch that too, not just its transcript sections.
    if (running && options?.forceSystemPrompt !== undefined) {
      const forced = options.forceSystemPrompt;
      const original = forced === forcedProjection?.projected ? forcedProjection.original : forced;
      const patched = replaceForcedPreamble(messages, original, body);
      forcedProjection = { original, projected: patched };
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
  const transition = (ctx: ExtensionContext, soul: string | null | undefined): string | undefined => {
    const branch = ctx.sessionManager.getBranch();
    const previous = readTransition(branch);
    const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    const current: Transition = { model, soul: soul === undefined ? previous?.soul ?? null : soul };
    if (!previous) {
      pi.appendEntry(TRANSITION_ENTRY_TYPE, { version: 1, ...current });
      return;
    }
    if (sameTransition(previous, current)) return;
    pi.appendEntry(TRANSITION_ENTRY_TYPE, { version: 1, ...current });
    const lines = transitionLines(previous, current);
    return lines.length ? formatTransitionReminder(lines) : undefined;
  };

  const reminder = (content: string): AgentMessage => ({
    role: "custom",
    customType: TRANSITION_MESSAGE_TYPE,
    content,
    display: false,
    details: { version: 1 },
    timestamp: Date.now(),
  });

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
      projection = { known: false, soul: null };
      setFooter(ctx, undefined);
      report(error, ctx);
    }
  });

  // A separate handler still runs after the runner catches a projection throw.
  pi.on("context_with_system", (event, ctx) => {
    if (!running || !userRun) return;
    if (!transitionComputed) {
      // A failed soul load or projection never becomes the new soul; the brain still reports.
      pendingReminder = transition(ctx, projection?.known ? projection.soul : undefined);
      transitionComputed = true;
    }
    if (!pendingReminder) return;
    return { messages: [...event.messages, reminder(pendingReminder)] };
  });
}
