import { it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import smartCompactExtension from "../extensions/smart-compact.ts";

it.each([false, true])(
  "uses Pi's completed compaction before continuing (summary replaced: %s)",
  async (replaceSummary) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "smart-compact-runtime-"));
    let session;
    try {
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const model = modelRegistry.getAll()[0];
      assert.ok(model);
      authStorage.setRuntimeApiKey(model.provider, "unused-test-key");
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 },
      });
      let smartTool;
      const loader = new DefaultResourceLoader({
        cwd: tempRoot,
        agentDir: tempRoot,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => {
            smartCompactExtension({
              ...pi,
              registerTool(tool) {
                smartTool = tool;
                pi.registerTool(tool);
              },
            });
            if (replaceSummary) {
              pi.on("session_before_compact", (event) => ({
                compaction: {
                  summary: "Summary from another extension",
                  firstKeptEntryId: event.preparation.firstKeptEntryId,
                  tokensBefore: event.preparation.tokensBefore,
                },
              }));
            }
          },
        ],
      });
      await loader.reload();
      const sessionManager = SessionManager.inMemory(tempRoot);
      for (const text of ["Earlier task context. ".repeat(100), "Continue the task."]) {
        sessionManager.appendMessage({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        });
      }
      ({ session } = await createAgentSession({
        cwd: tempRoot,
        agentDir: tempRoot,
        authStorage,
        modelRegistry,
        model,
        settingsManager,
        sessionManager,
        resourceLoader: loader,
        tools: ["smart_compact"],
      }));
      const errors = [];
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      const sessionId = sessionManager.getSessionId();
      const sends = [];
      session.sendUserMessage = async (message, options) => {
        assert.equal(session.isCompacting, false, "continuation must wait until Pi clears its compaction guard");
        sends.push({ message, options });
      };
      session.agent.streamFn = () => {
        throw new Error("This test must not call a model provider");
      };

      await smartTool.execute(
        "runtime-smart-compact",
        { handoff: "Task paused safely. Next steps: finish the remaining work." },
        new AbortController().signal,
        () => {},
        session.extensionRunner.createContext(),
      );
      // ctx.compact is deliberately fire-and-forget; let its real callback finish.
      await new Promise((resolve) => setImmediate(resolve));

      const compactions = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
      assert.equal(compactions.length, 1);
      assert.equal(session.isCompacting, false);
      assert.equal(sessionManager.getSessionId(), sessionId);
      assert.deepEqual(errors, []);
      assert.deepEqual(sends, replaceSummary ? [] : [{ message: "continue", options: { deliverAs: "followUp" } }]);
    } finally {
      session?.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
);
