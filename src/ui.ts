import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { dividerText, FOOTER_KEY, PRESENCE_ENTRY_TYPE } from "./presence.ts";

export function registerPresenceUI(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(PRESENCE_ENTRY_TYPE, (entry, _options, theme) => {
    const text = dividerText(entry.data);
    return text === undefined ? undefined : new Text(theme.fg("dim", text), 0, 0);
  });
}

export function setFooter(ctx: ExtensionContext, text: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(FOOTER_KEY, text);
}

export function appendDivider(pi: ExtensionAPI, name: string | null): void {
  pi.appendEntry(PRESENCE_ENTRY_TYPE, { version: 1, name });
}
