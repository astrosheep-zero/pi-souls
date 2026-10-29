#!/usr/bin/env node
// Runs one soul's reaction module outside the mod's sandbox, which has no Node
// and no `import()`. Called as:
//   node --experimental-strip-types reaction-runner.mjs <reactionPath> <json>
//
// Prints one line: the utterance as JSON, or nothing at all. A broken module, a
// throwing call, or a malformed answer is silent: a reaction never breaks the host.
import { pathToFileURL } from "node:url";

const [reactionPath, payload] = process.argv.slice(2);
if (!reactionPath || !payload) process.exit(0);

let line;
try {
  const module = await import(pathToFileURL(reactionPath).href);
  const reaction = typeof module.reaction === "function" ? module.reaction : typeof module.default === "function" ? module.default : undefined;
  if (!reaction) process.exit(0);
  const { moment, world } = JSON.parse(payload);
  const said = await reaction(moment, world);
  if (typeof said !== "object" || said === null || typeof said.text !== "string" || !said.text.trim()) process.exit(0);
  const audience = said.audience === "human" || said.audience === "both" || said.audience === "model" ? said.audience : undefined;
  line = JSON.stringify(audience ? { text: said.text, audience } : { text: said.text });
} catch {
  process.exit(0);
}
process.stdout.write(`${line}\n`);
