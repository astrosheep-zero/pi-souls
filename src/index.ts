import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySoul } from "./prompt.ts";
import { ENTRY_TYPE, listSouls, loadSoul, readConfig, resolveSoul, sessionSoul, unmatchableModelKeys, type Selection } from "./souls.ts";

const home = homedir();
const tilde = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

function describe(selection: Selection | undefined, model: ExtensionContext["model"]): string {
  if (!selection) return "none (Pi's default prompt)";
  if (selection.source === "session") return `${selection.name} (chosen for this session)`;
  if (selection.source === "model") return `${selection.name} (modelSouls for ${model?.provider}/${model?.id})`;
  return `${selection.name} (defaultSoul)`;
}

export default function soulsExtension(pi: ExtensionAPI) {
  // Argument completion has no context; remember where the session runs for relative soulsDir.
  let cwd = process.cwd();
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });

  pi.registerCommand("soul", {
    description: "Switch persona: /soul <name> for this session, /soul clear to follow defaults, /soul to list",
    getArgumentCompletions: (prefix) => {
      try {
        const souls = listSouls(readConfig(pi.getSettings(), cwd).dir).map((name) => ({ value: name, label: name }));
        const items = [...souls, { value: "clear", label: "clear", description: "Drop the session soul, follow modelSouls / defaultSoul" }];
        const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
        return matches.length ? matches : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const notify = (text: string) => ctx.ui.notify(text, "info");
      if (!ctx.isIdle()) {
        ctx.ui.notify("Souls can't change mid-run. Try again once the agent is idle.", "warning");
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
          if (!selected) return notify(`No session soul to clear. Soul: ${now()}`);
          pi.appendEntry(ENTRY_TYPE, { version: 1, name: null });
          return notify(`Session soul cleared. Soul: ${now()}`);
        }

        const available = listSouls(config.dir);
        if (name) {
          if (override() === name) return notify(`Already using ${name} for this session.`);
          if (!available.includes(name)) {
            throw new Error(`No soul named "${name}" in ${tilde(config.dir)}. Available: ${available.join(", ") || "none"}`);
          }
          loadSoul(config.dir, name); // Validate content before changing durable session state.
          pi.appendEntry(ENTRY_TYPE, { version: 1, name });
          return notify(`Soul set to ${name} for this session.`);
        }

        const selection = resolveSoul(config, override(), ctx.model);
        const missing = selection && !available.includes(selection.name) ? " (file not found)" : "";
        const ignored = unmatchableModelKeys(config);
        notify([
          `Soul: ${describe(selection, ctx.model)}${missing}`,
          `Available: ${available.join(", ") || "none"}`,
          `Folder: ${tilde(config.dir)}`,
          ...(ignored.length ? [`Ignored modelSouls keys (need provider/modelId): ${ignored.join(", ")}`] : []),
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
