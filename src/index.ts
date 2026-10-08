import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySoul } from "./prompt.ts";
import { ENTRY_TYPE, listSouls, loadSoul, readConfig, resolveSoul, sessionSoul } from "./souls.ts";

export default function soulsExtension(pi: ExtensionAPI) {
  function current(ctx: ExtensionContext) {
    const config = readConfig(pi.getSettings(), ctx.cwd);
    const selection = resolveSoul(config, sessionSoul(ctx.sessionManager.getBranch()), ctx.model);
    return { config, selection };
  }

  pi.registerCommand("soul", {
    description: "Show souls, select /soul <name>, or /soul clear to follow defaults",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the active run before changing souls.", "warning");
        return;
      }
      try {
        const name = args.trim();
        if (name === "clear") {
          pi.appendEntry(ENTRY_TYPE, { version: 1, name: null });
        } else if (name) {
          const { config } = current(ctx);
          loadSoul(config.dir, name); // Validate before changing durable session state.
          pi.appendEntry(ENTRY_TYPE, { version: 1, name });
        }
        const { config, selection } = current(ctx);
        const status = selection ? `${selection.name} (${selection.source})` : "Pi default";
        const available = !name ? `\nAvailable: ${listSouls(config.dir).join(", ") || "none"}\nDirectory: ${config.dir}` : "";
        ctx.ui.notify(`Soul: ${status}${available}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("context_with_system", (event, ctx) => {
    const { config, selection } = current(ctx);
    if (!selection) return;
    return { messages: applySoul(event.messages, loadSoul(config.dir, selection.name)) };
  });
}
