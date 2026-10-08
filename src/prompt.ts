import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Request-only projection. Keep runtime sections, declaration deltas and conversation intact. */
export function applySoul(messages: AgentMessage[], body: string): AgentMessage[] {
  const head = messages[0];
  if (head?.role !== "system" || typeof head.sections?.preamble !== "string" || head.content) {
    throw new Error("Soul requires a structured Pi system prompt; an opaque full-prompt override cannot be combined with it");
  }
  return messages.map((message) => {
    if (message.role !== "system" || !Object.hasOwn(message.sections ?? {}, "preamble")) return message;
    // Rewrite historical preamble deltas too: an old identity must not override today's soul.
    return { ...message, sections: { ...message.sections, preamble: body } };
  });
}
