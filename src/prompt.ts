import type { AgentMessage } from "@earendil-works/pi-agent-core";

type SystemMessage = Extract<AgentMessage, { role: "system" }>;

function hasPreamble(message: AgentMessage): message is SystemMessage {
  return message.role === "system" && typeof message.sections?.preamble === "string";
}

/**
 * Request-only projection. Keep runtime sections, declaration deltas and conversation intact.
 * Pi replays every system message in order and the preamble can sit in a later one (sessions older
 * than system messages), so every preamble patch carries the soul: an old identity must not win.
 */
export function applySoul(messages: AgentMessage[], body: string): AgentMessage[] {
  if (!messages.some(hasPreamble)) throw new Error("Soul skipped: the prompt has no preamble");
  return messages.map((message) => hasPreamble(message) ? { ...message, sections: { ...message.sections, preamble: body } } : message);
}
