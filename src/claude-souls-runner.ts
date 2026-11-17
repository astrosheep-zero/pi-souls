// Built into the standalone Claude plugin; never loaded by its sandbox.
import { listSouls, readConfig, readSoul, soulPerceptionPath, type SoulVariables } from "./soul-content.ts";

export type SoulTask = { soulsDir?: string; cwd: string } & (
  | { op: "read"; name: string; model: SoulVariables["model"] }
  | { op: "list" }
  | { op: "perception"; name: string }
);

try {
  const task: SoulTask = JSON.parse(process.argv[2] ?? "");
  const { dir } = readConfig({ soulsDir: task.soulsDir }, task.cwd);
  let result;
  switch (task.op) {
    case "read": result = { dir, ...readSoul(dir, task.name, { cwd: task.cwd, model: task.model }) }; break;
    case "list": result = { dir, names: listSouls(dir) }; break;
    case "perception": result = { dir, path: soulPerceptionPath(dir, task.name) }; break;
    default: throw new Error("Unknown soul operation");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
