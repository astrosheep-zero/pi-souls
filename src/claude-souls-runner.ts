// Built into the standalone Claude plugin; never loaded by its sandbox.
import { readFileSync } from "node:fs";
import { readClaudeSession } from "./claude-session.ts";
import { listSouls, readConfig, readSoul, soulPerceptionPath, type SoulVariables } from "./soul-content.ts";

export type SoulTask = { soulsDir?: string; cwd: string } & (
  | { op: "read"; name: string; model: SoulVariables["model"] }
  | { op: "list" }
  | { op: "perception"; name: string }
  | { op: "session"; transcriptPath: string; headUuid: string; handles?: string[]; sessionId?: string }
);

try {
  const task: SoulTask = JSON.parse(process.argv[2] ?? "");
  const dir = task.op === "session" ? "" : readConfig({ soulsDir: task.soulsDir }, task.cwd).dir;
  let result;
  switch (task.op) {
    case "session": {
      try { result = readClaudeSession(readFileSync(task.transcriptPath, "utf8"), task.headUuid, task.handles, task.sessionId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        result = { known: false }; // A kept first append may precede file creation.
      }
      break;
    }
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
