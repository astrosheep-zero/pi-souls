import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Load through Pi's extension loader, not only through a direct Node import.
test("Pi loads a changed reaction after /soul reload without starting a model request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-reaction-sdk-"));
  let dispose: (() => void) | undefined;
  try {
    const soul = join(dir, "faye");
    const marker = join(dir, "reaction-output");
    const reaction = join(soul, "reaction.ts");
    const code = (value: string) => `import { writeFileSync } from 'node:fs'; enum Marker { value = ${JSON.stringify(value)} } export function reaction() { writeFileSync(${JSON.stringify(marker)}, Marker.value); }`;
    mkdirSync(soul);
    writeFileSync(join(soul, "SOUL.md"), "Faye");
    writeFileSync(reaction, code("old"));
    const settings = SettingsManager.inMemory({ soulsDir: dir, timeaware: false } as any);
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = modelRuntime.getModels("openai")[0]!;
    await modelRuntime.setRuntimeApiKey(model.provider, "test-key-never-sent");
    const sessionManager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings, sessionManager, modelRuntime, model, resourceLoader: loader, noTools: "all" });
    dispose = () => session.dispose();
    const requests: Parameters<StreamFn>[1][] = [];
    session.agent.streamFunction = (requestModel, context) => {
      requests.push(structuredClone(context));
      const message = {
        role: "assistant" as const, content: [{ type: "text", text: "Done" }],
        api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
        result: async () => message,
      } as unknown as Awaited<ReturnType<StreamFn>>;
    };
    const errors: string[] = [];
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    await session.prompt("/soul @faye");
    await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    assert.equal(readFileSync(marker, "utf8"), "old");

    writeFileSync(reaction, code("new"));
    mkdirSync(join(soul, "parts"));
    writeFileSync(join(soul, "parts", "shared.md"), "fresh snippet");
    writeFileSync(join(soul, "SOUL.md"), "Faye {{ model.id }} {% render 'parts/shared' %}");
    const selected = sessionManager.getBranch().length;
    await session.prompt("/soul reload");
    assert.equal(sessionManager.getBranch().length, selected);
    assert.equal(requests.length, 0);
    assert.equal(readFileSync(marker, "utf8"), "old");
    await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    assert.equal(readFileSync(marker, "utf8"), "new");

    // Native ESM needs a fresh URL even when Pi loaded this extension through Jiti.
    const esm = join(soul, "reaction.mjs");
    const esmCode = (value: string) => `import { writeFileSync } from 'node:fs'; export function reaction() { writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)}); }`;
    rmSync(reaction);
    writeFileSync(esm, esmCode("esm-old"));
    await session.prompt("/soul reload");
    await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    assert.equal(readFileSync(marker, "utf8"), "esm-old");
    writeFileSync(esm, esmCode("esm-new"));
    await session.prompt("/soul reload");
    await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
    assert.equal(readFileSync(marker, "utf8"), "esm-new");
    assert.equal(requests.length, 0);

    await session.prompt("hello");
    assert.equal(requests.length, 1);
    const system = requests[0].messages[0];
    assert.ok(system.role === "system");
    assert.equal(system.sections?.preamble, `Faye ${model.id} fresh snippet`);
    assert.deepEqual(errors, []);
  } finally {
    dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
