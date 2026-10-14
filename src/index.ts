import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySoul, replaceForcedPreamble } from "./prompt.ts";
import { ENTRY_TYPE, effectiveSoul, listSouls, loadSoul, readConfig, resolveSoul, sessionSoul, unmatchableModelKeys, type Selection } from "./souls.ts";

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function describe(selection: Selection | undefined, model: ExtensionContext["model"], suppressed = false, soulless = false): string {
  if (!selection) return soulless ? "none (soulless)" : suppressed ? "none (custom prompt)" : "none";
  if (selection.source === "model") return `${selection.name} (${model?.provider}/${model?.id})`;
  return `${selection.name} (${selection.source})`;
}

export default function soulsExtension(pi: ExtensionAPI) {
  pi.registerFlag("soulless", { description: "Skip default souls (session /soul still wins)", type: "boolean", default: false });
  const soulless = () => pi.getFlag("soulless") === true || /^(1|true)$/i.test(process.env.SOULLESS ?? "");
  // Argument completion has no context; remember where the session runs for relative soulsDir.
  let cwd = process.cwd();
  // A problem is reported when it appears or changes, not on every request of a tool loop.
  let reported: string | undefined;
  // Hold live options: handlers after ours can still set customPrompt or forceSystemPrompt.
  let options: BuildSystemPromptOptions | undefined;
  let running = false;
  let forceReported = false;
  // Retain the original text so tool-loop requests and soul edits do not patch our own output.
  let forcedProjection: { original: string; projected: string } | undefined;
  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd; reported = undefined; forceReported = false;
    options = undefined; running = false; forcedProjection = undefined;
  });
  pi.on("before_agent_start", (event) => {
    options = event.systemPromptOptions; running = true; forcedProjection = undefined;
  });
  pi.on("agent_settled", () => { running = false; });

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
        const override = () => sessionSoul(ctx.sessionManager.getBranch());
        const resolved = () => resolveSoul(config, override(), ctx.model, soulless());
        const now = () => {
          const configured = resolved();
          const active = effectiveSoul(configured, prompt);
          return describe(active, ctx.model, active === undefined && configured !== undefined, soulless());
        };

        if (name === "clear") {
          let selected = true; // A corrupted selection counts as something to clear.
          try { selected = override() !== undefined; } catch {}
          if (!selected) return notify(`No session soul. Soul: ${now()}`);
          pi.appendEntry(ENTRY_TYPE, { version: 1, name: null });
          return notify(`Cleared. Soul: ${now()}`);
        }

        const available = listSouls(config.dir);
        if (name) {
          if (override() === name) return notify(`Already ${name}.`);
          if (!available.includes(name)) {
            throw new Error(`No soul "${name}". Souls: ${available.join(", ") || "none"}`);
          }
          loadSoul(config.dir, name); // Validate content before changing durable session state.
          pi.appendEntry(ENTRY_TYPE, { version: 1, name });
          return notify(`Soul: ${name}`);
        }

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
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const project = (messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] | undefined => {
    const config = readConfig(pi.getSettings(), ctx.cwd);
    const selection = effectiveSoul(resolveSoul(config, sessionSoul(ctx.sessionManager.getBranch()), ctx.model, soulless()), options?.customPrompt);
    if (!selection) return undefined;
    const body = loadSoul(config.dir, selection.name);
    const projected = applySoul(messages, body);
    // Pi projects forced text after this hook; patch that too, not just its transcript sections.
    if (running && options?.forceSystemPrompt !== undefined) {
      if (!forceReported) {
        const warning = "Soul: another extension forced the prompt; attempting preamble replacement";
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
        else console.warn(warning);
        forceReported = true;
      }
      const forced = options.forceSystemPrompt;
      const original = forced === forcedProjection?.projected ? forcedProjection.original : forced;
      const patched = replaceForcedPreamble(messages, original, body);
      forcedProjection = { original, projected: patched };
      options.forceSystemPrompt = patched;
    } else {
      forceReported = false;
    }
    return projected;
  };

  pi.on("context_with_system", (event, ctx) => {
    try {
      const messages = project(event.messages, ctx);
      reported = undefined;
      return messages && { messages };
    } catch (error) {
      // The request goes out with Pi's own prompt; an unchanged problem skips quietly.
      const problem = error instanceof Error ? error.message : String(error);
      if (problem === reported) return;
      reported = problem;
      // Without a UI (print mode), only a thrown error reaches the user, on stderr.
      if (!ctx.hasUI) throw error;
      ctx.ui.notify(problem, "warning");
    }
  });
}
