import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import extension from "../src/index.ts";

// Real Pi lifecycle and tool loop; only the provider stream is replaced. No network or personal settings.
test("SDK request projection preserves durable identity, tools and forced addenda through a template failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "souls-sdk-"));
  let dispose: (() => void) | undefined;
  try {
    writeFileSync(join(dir, "faye.md"), "Faye {{ model.id }} in {{ cwd }}");
    writeFileSync(join(dir, "input.txt"), "Tool result stays intact");
    const settings = { defaultSoul: "faye", soulsDir: dir, compaction: { enabled: false }, retry: { enabled: false } };
    const settingsManager = SettingsManager.inMemory(settings);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false,
    });
    const model = modelRuntime.getModels("openai")[0];
    assert.ok(model, "static catalog supplies a model without network");
    await modelRuntime.setRuntimeApiKey(model.provider, "test-key-never-sent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [extension, (pi) => {
        pi.on("before_agent_start", (event) => {
          event.systemPromptOptions.forceSystemPrompt = `${event.systemPrompt}\nKEEP EXTRA`;
        });
        pi.on("tool_result", () => {
          writeFileSync(join(dir, "faye.md"), "{{ model.typo }}");
        });
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const sessionManager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, settingsManager, sessionManager,
      modelRuntime, model, resourceLoader, tools: ["read"], thinkingLevel: "off",
    });
    dispose = () => session.dispose();
    const errors: string[] = [];
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    const requests: Parameters<StreamFn>[1][] = [];
    session.agent.streamFunction = (requestModel, context) => {
      requests.push(structuredClone(context));
      const first = requests.length === 1;
      const message = {
        role: "assistant" as const,
        content: first
          ? [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: join(dir, "input.txt") } }]
          : [{ type: "text", text: "Done" }],
        api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
        result: async () => message,
      } as unknown as Awaited<ReturnType<StreamFn>>;
    };
    await session.prompt("Read input.txt");
    assert.equal(requests.length, 2);
    const first = requests[0].messages[0];
    const second = requests[1].messages[0];
    assert.ok(first.role === "system" && second.role === "system");
    assert.ok(typeof first.content === "string" && typeof second.content === "string");
    assert.ok(first.content.includes(`Faye ${model.id} in ${dir}`));
    assert.ok(first.content.endsWith("KEEP EXTRA"));
    assert.ok(!second.content.includes("Faye"), JSON.stringify({ errors, received: second.content.split("\n")[0] }));
    assert.ok(second.content.endsWith("KEEP EXTRA"));
    assert.deepEqual(first.toolsAdded, second.toolsAdded);
    assert.ok(first.toolsAdded?.some((tool) => tool.name === "read"));
    const toolResult = requests[1].messages.find((message) => message.role === "toolResult");
    assert.ok(toolResult && JSON.stringify(toolResult).includes("Tool result stays intact"));
    assert.ok(errors.some((error) => error.includes('Soul "faye" template:')));
    const systemEntries = sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "system");
    assert.ok(systemEntries.length > 0);
    assert.ok(systemEntries.every((entry) => !JSON.stringify(entry).includes("Faye")));
  } finally {
    dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
