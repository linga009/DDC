import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ModelCatalog } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";
import { KeywordSafetyClassifier } from "../src/safety_classifier.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import { SwarmClient } from "../src/client.ts";

const AGENT_BINARY = process.platform === "win32"
  ? "../build/core/swarm-node-agent.exe"
  : "../build/core/swarm-node-agent";
const MODEL_PATH = "../models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
const AGENT_PORT = 51099;

const skipReason = !existsSync(AGENT_BINARY)
  ? `${AGENT_BINARY} not built -- run "cmake --build build" from the repo root first`
  : !existsSync(MODEL_PATH)
  ? `${MODEL_PATH} not found -- run scripts/download_test_model.sh from the repo root first`
  : undefined;

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: "Bearer test-secret-token-1234" },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      // not up yet -- keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`swarm-node-agent did not become healthy on port ${port} within ${timeoutMs}ms`);
}

test(
  "POST /generate produces a real completion from a real swarm-node-agent process",
  { skip: skipReason },
  async () => {
    // On Windows, the MinGW/MSYS2 UCRT64 toolchain's runtime DLLs (e.g.
    // libgomp-1.dll) live in the toolchain's own bin directory, which is not
    // necessarily on PATH for whatever process spawns this test (it depends
    // on the shell's own PATH, not on this repo's build config). Without it,
    // the agent process fails immediately with "error while loading shared
    // libraries" and this test would time out waiting for /health rather
    // than surfacing the real cause. Prepending it here is a no-op on
    // platforms/shells that already have it on PATH, and a harmless no-op
    // on non-Windows platforms (guarded by process.platform).
    const spawnEnv = process.platform === "win32"
      ? { ...process.env, PATH: `C:\\msys64\\ucrt64\\bin;${process.env.PATH ?? ""}`, SWARM_AUTH_TOKEN: "test-secret-token-1234" }
      : { ...process.env, SWARM_AUTH_TOKEN: "test-secret-token-1234" };
    const agent: ChildProcess = spawn(AGENT_BINARY, ["--model", MODEL_PATH, "--port", String(AGENT_PORT)], { env: spawnEnv });
    try {
      await waitForHealth(AGENT_PORT, 30000);

      const registry = new NodeRegistry();
      const catalog = new ModelCatalog([{ id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 }]);
      const peers = new PeerRegistry();
      const classifier = new KeywordSafetyClassifier([]);
      const reputation = new ReputationTracker();
      const server = createServer(registry, catalog, peers, classifier, reputation, "test-secret-token-1234");
      await new Promise<void>(resolve => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected server to bind to a port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const client = new SwarmClient(baseUrl, "test-secret-token-1234");
        await client.registerNode(`http://127.0.0.1:${AGENT_PORT}`, "desktop", undefined, "tinyllama-1.1b");

        const result = await client.generate("The capital of France is", "tinyllama-1.1b", 8);
        assert.equal(typeof result.text, "string");
        assert.ok(result.text.length > 0);
      } finally {
        server.close();
      }
    } finally {
      agent.kill();
    }
  },
);
