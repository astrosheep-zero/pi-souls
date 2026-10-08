import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySoul } from "./prompt.ts";
import { ENTRY_TYPE, listSouls, loadSoul, readConfig, resolveSoul, sessionSoul, unmatchableModelKeys, type Selection } from "./souls.ts";

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function describe(selection: Selection | undefined, model: ExtensionContext["model"]): string {
  if (!selection) return "none";
  if (selection.source === "model") return `${selection.name} (${model?.provider}/${model?.id})`;
  return `${selection.name} (${selection.source})`;
}

export default function soulsExtension(pi: ExtensionAPI) {
  // Argument completion has no context; remember where the session runs for relative soulsDir.
  let cwd = process.cwd();
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });

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
        const override = () => sessionSoul(ctx.sessionManager.getBranch());
        const now = () => describe(resolveSoul(config, override(), ctx.model), ctx.model);

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

        const selection = resolveSoul(config, override(), ctx.model);
        const missing = selection && !available.includes(selection.name) ? " (missing)" : "";
        const ignored = unmatchableModelKeys(config);
        notify([
          `Soul: ${describe(selection, ctx.model)}${missing}`,
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
    const selection = resolveSoul(config, sessionSoul(ctx.sessionManager.getBranch()), ctx.model);
    if (!selection) return;
    return { messages: applySoul(event.messages, loadSoul(config.dir, selection.name)) };
  });
}
