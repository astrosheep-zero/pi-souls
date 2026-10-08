import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySoul } from "./prompt.ts";
import { ENTRY_TYPE, effectiveSoul, listSouls, loadSoul, readConfig, resolveSoul, sessionSoul, unmatchableModelKeys, type Selection } from "./souls.ts";

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function describe(selection: Selection | undefined, model: ExtensionContext["model"], suppressed = false): string {
  if (!selection) return suppressed ? "none (custom prompt)" : "none";
  if (selection.source === "model") return `${selection.name} (${model?.provider}/${model?.id})`;
  return `${selection.name} (${selection.source})`;
}

export default function soulsExtension(pi: ExtensionAPI) {
  // Argument completion has no context; remember where the session runs for relative soulsDir.
  let cwd = process.cwd();
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
  // context_with_system cannot read prompt options; before_agent_start can, and runs first.
  let customPrompt: string | undefined;
  pi.on("before_agent_start", (event) => { customPrompt = event.systemPromptOptions.customPrompt; });

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
        const resolved = () => resolveSoul(config, override(), ctx.model);
        const now = () => {
          const configured = resolved();
          const active = effectiveSoul(configured, prompt);
          return describe(active, ctx.model, active === undefined && configured !== undefined);
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
          `Soul: ${describe(selection, ctx.model, selection === undefined && configured !== undefined)}${missing}`,
          `Souls: ${available.join(", ") || "none"}`,
          `Dir: ${tilde(config.dir)}`,
          ...(ignored.length ? [`Ignored keys: ${ignored.join(", ")}`] : []),
        ].join("\n"));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("context_with_system", (event, ctx) => {
    const config = readConfig(pi.getSettings(), ctx.cwd);
    const selection = effectiveSoul(resolveSoul(config, sessionSoul(ctx.sessionManager.getBranch()), ctx.model), customPrompt);
    if (!selection) return;
    return { messages: applySoul(event.messages, loadSoul(config.dir, selection.name)) };
  });
}
