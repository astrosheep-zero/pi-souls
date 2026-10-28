#!/usr/bin/env node
// Runs one soul's voice module outside the mod's sandbox, which has no Node and
// no `import()`. Called as: node --experimental-strip-types voice-runner.mjs <voicePath> <json>
//
// Prints one line: the utterance as JSON, or nothing at all. A broken module, a
// throwing call, or a malformed answer is silent: voice never breaks the host.
import { pathToFileURL } from "node:url";

const [voicePath, payload] = process.argv.slice(2);
if (!voicePath || !payload) process.exit(0);

let line;
try {
  const module = await import(pathToFileURL(voicePath).href);
  const voice = typeof module.voice === "function" ? module.voice : typeof module.default === "function" ? module.default : undefined;
  if (!voice) process.exit(0);
  const { moment, world } = JSON.parse(payload);
  const said = await voice(moment, world);
  if (typeof said !== "object" || said === null || typeof said.text !== "string" || !said.text.trim()) process.exit(0);
  const audience = said.audience === "human" || said.audience === "both" || said.audience === "model" ? said.audience : undefined;
  line = JSON.stringify(audience ? { text: said.text, audience } : { text: said.text });
} catch {
  process.exit(0);
}
process.stdout.write(`${line}\n`);
