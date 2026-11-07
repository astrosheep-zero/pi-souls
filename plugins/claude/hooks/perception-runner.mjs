#!/usr/bin/env node
// Runs one soul's perception module outside the mod's sandbox, which has no Node
// and no `import()`. Called as:
//   node --experimental-strip-types perception-runner.mjs <perceptionPath> <json>
//
// Prints one line: the utterance as JSON, or nothing at all. A broken module, a
// throwing call, or a malformed answer is silent: a perception never breaks the host.
import { pathToFileURL } from "node:url";

const [perceptionPath, payload] = process.argv.slice(2);
if (!perceptionPath || !payload) process.exit(0);

let line;
try {
  const module = await import(pathToFileURL(perceptionPath).href);
  const pick = value => value != null && (typeof value === "object" || typeof value === "function")
    ? typeof value.perception === "function" ? value.perception : typeof value.default === "function" ? value.default : typeof value === "function" ? value : undefined
    : undefined;
  const perception = pick(module) ?? pick(module.default);
  if (!perception) process.exit(0);
  const { moment, world } = JSON.parse(payload);
  const said = await perception(moment, world);
  if (typeof said !== "object" || said === null || Array.isArray(said) || typeof said.text !== "string" || !said.text.trim()) process.exit(0);
  line = JSON.stringify({ text: said.text });
} catch {
  process.exit(0);
}
process.stdout.write(`${line}\n`);
