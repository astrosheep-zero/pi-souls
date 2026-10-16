import type { EngineInterface, On, PluginOptions } from "claude-code";

type Engine = Pick<EngineInterface, "fs" | "env" | "session" | "ui">;

function isName(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value);
}
async function load($: Engine, name: string): Promise<string> {
  if (!isName(name)) throw new Error(`Invalid soul: ${name}`);
  const home = await $.env.get("HOME") ?? await $.env.get("USERPROFILE");
  if (!home) throw new Error("Home directory unavailable");
  const path = `${home}/.agents/souls/${name}.md`;
  if (!await $.fs.exists(path)) throw new Error(`Soul "${name}" not found`);
  const text = await $.fs.read(path);
  // Strip only a leading, closed YAML frontmatter block; no YAML runtime is needed.
  const body = text.replace(/^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/, "").trim();
  if (!body) throw new Error(`Soul "${name}" is empty`);
  return body;
}

/** Keep leading whitespace and the first paragraph's exact separator and suffix. */
export function replaceIdentity(text: string, body: string): string | undefined {
  const start = /^\s*/.exec(text)![0].length;
  if (!/^You are\b/.test(text.slice(start))) return undefined;
  const separator = /\r?\n[\t ]*\r?\n/.exec(text.slice(start));
  const end = separator ? start + separator.index : text.length;
  return text.slice(0, start) + body + text.slice(end);
}
async function warnOnce($: Engine, reported: Set<string>, message: string) {
  const key = `${await $.session.id()}:${message}`;
  if (reported.has(key)) return;
  reported.add(key);
  $.ui.log(`Soul: ${message}`);
}
async function select($: Engine, options: PluginOptions, model: string, reported: Set<string>): Promise<string | undefined> {
  let name = options.defaultSoul as string | undefined;
  for (const entry of (options.modelSouls ?? []) as readonly string[]) {
    const match = /^([^=\s]+)=([^=]+)$/.exec(entry);
    if (!match || !isName(match[2])) {
      await warnOnce($, reported, `Ignoring invalid model entry: ${JSON.stringify(entry)} (expected model=soul)`);
      continue;
    }
    if (match[1] === model) name = match[2];
  }
  return name || undefined;
}

export function register(on: On, options: PluginOptions = {}) {
  const reported = new Set<string>();
  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    try {
      if (/^(1|true)$/i.test(await $.env.get("SOULLESS") ?? "")) return result;
      const name = await select($, options, e.model, reported);
      if (!name) return result;
      const target = e.traits.includes("lean") ? "lean_body" : "intro";
      const index = result.sections.findIndex((section) => section.id === target);
      const section = result.sections[index];
      if (!section) {
        await warnOnce($, reported, "Skipped: no matching opening paragraph");
        return result;
      }
      const text = replaceIdentity(section.text, await load($, name));
      if (text === undefined) {
        await warnOnce($, reported, "Skipped: no matching opening paragraph");
        return result;
      }
      return { ...result, sections: result.sections.map((item, i) => i === index ? { ...item, text } : item) };
    } catch (error) {
      await warnOnce($, reported, `Skipped: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  });
}
