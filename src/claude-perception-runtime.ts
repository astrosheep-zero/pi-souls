// Standalone Node runtime. Its retained host process stream owns its lifetime.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadPerception, type Moment, type Perception, type World } from "./perception.ts";

const temp = resolve(tmpdir());
if (process.argv[2] === "--cleanup") {
  const socket = process.argv[3] ?? "";
  const dir = dirname(socket);
  if (basename(socket) === "p" && dirname(dir) === temp && basename(dir).startsWith("pi-souls-")) {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const dir = mkdtempSync(join(temp, "pi-souls-"));
  const socketPath = join(dir, "p");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", cleanup);
  // Leave TERM/INT to the OS: a JS signal handler cannot run while a perception
  // blocks the event loop and would suppress the default process termination.

  // As in Pi: one current extension per session and soul directory, not a cache
  // of historical paths that could resurrect an entry when extensions change.
  const entries = new Map<string, { path: string; perception: Perception }>();
  const key = (sessionId: string, directory: string) => JSON.stringify([sessionId, directory]);
  const server = createServer(async (request, response) => {
    try {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1_048_576) throw new Error("Perception request too large");
      }
      const task = JSON.parse(body) as { path: string; dir: string; sessionId?: string; moment: Moment; world: World };
      let said;
      if (request.url === "/reload") {
        if (typeof task.sessionId !== "string" || typeof task.dir !== "string") throw new Error("Missing reload identity");
        entries.delete(key(task.sessionId, task.dir));
      } else if (request.url === "/perceive") {
        if (typeof task.path !== "string") throw new Error("Missing perception path");
        const id = key(task.world.sessionId, dirname(task.path));
        let entry = entries.get(id);
        if (!entry || entry.path !== task.path) {
          entry = { path: task.path, perception: loadPerception(task.path) };
          entries.set(id, entry);
        }
        said = await entry.perception(task.moment, task.world);
      } else {
        throw new Error("Unknown perception operation");
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(said ?? {}));
    } catch {
      response.writeHead(400).end("{}");
    }
  });
  server.on("error", () => process.exit(1));
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    process.stdout.write(`${JSON.stringify({ socketPath })}\n`);
  });
}
