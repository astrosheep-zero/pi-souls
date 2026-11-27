import type { AgentMessage } from "@earendil-works/pi-agent-core";

type SystemMessage = Extract<AgentMessage, { role: "system" }>;

function hasPreamble(message: AgentMessage): message is SystemMessage {
  return message.role === "system" && typeof message.sections?.preamble === "string";
}

/** Forced prompts render the latest replayed preamble; leave appended instructions intact. */
export function replaceForcedPreamble(messages: AgentMessage[], prompt: string, body: string): string {
  const preamble = messages.findLast(hasPreamble)?.sections?.preamble;
  if (!preamble || !prompt.includes(preamble)) throw new Error("Soul: replacement failed — no preamble");
  // Use a callback so $ sequences in a soul are literal, not replacement patterns.
  return prompt.replace(preamble, () => body);
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

function nakedSystemMessage(message: SystemMessage, content: string): SystemMessage {
  const { sections: _sections, ...rest } = message;
  return { ...rest, content };
}

/**
 * Naked request-only projection: strip all system prompt sections and extra system text so the
 * prompt is strictly the soul body, while preserving tool declarations in place.
 */
export function applyNakedSoul(messages: AgentMessage[], body: string): AgentMessage[] {
  let placed = false;
  const result: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") {
      result.push(message);
      continue;
    }
    if (!placed) {
      placed = true;
      result.push(nakedSystemMessage(message, body));
      continue;
    }
    if (message.toolsAdded?.length || message.toolsRemoved?.length) {
      result.push(nakedSystemMessage(message, ""));
    }
  }
  if (!placed) result.unshift({ role: "system", content: body, timestamp: 0 });
  return result;
}

