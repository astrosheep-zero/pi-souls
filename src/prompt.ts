import type { AgentMessage } from "@earendil-works/pi-agent-core";

type SystemMessage = Extract<AgentMessage, { role: "system" }>;

function hasPreamble(message: AgentMessage | undefined): message is SystemMessage {
  return message?.role === "system" && typeof message.sections?.preamble === "string";
}

/** Request-only projection. Keep runtime sections, declaration deltas and conversation intact. */
export function applySoul(messages: AgentMessage[], body: string): AgentMessage[] {
  const head = messages[0];
  if (!hasPreamble(head) || head.content) {
    throw new Error("Soul not applied: the system prompt is fully replaced (SYSTEM.md or customPrompt), and souls only work with Pi's structured prompt");
  }
  // Rewrite historical preamble deltas too: an old identity must not override today's soul.
  return messages.map((message) => hasPreamble(message) ? { ...message, sections: { ...message.sections, preamble: body } } : message);
}
