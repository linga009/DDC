# Coordinator Request Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coordinator a real `POST /generate` endpoint — the first path in this whole repo where a client submits a prompt and gets a real generated response back, produced by routing through a registered `swarm-node-agent` (Plan 12).

**Prerequisite:** Plan 12 (`swarm-node-agent`) must be merged before this plan's opt-in end-to-end test (Task 3) can run — its fast, default tests (Tasks 1-2) have no such dependency and use a stub HTTP server standing in for a node agent, per the design spec's testing strategy.

**Architecture:** `NodeInfo` gains an optional `servesModel` field (mirroring exactly how Plan 9 added `localityGroup`) so a node agent can declare, at registration, which catalog model it serves at its registered `endpoint`. `POST /generate` reuses every piece of infrastructure already built — the existing `SafetyClassifier` gate (finally wired to something, per Plan 7's own "not yet wired into any request-submission path" disclosure), `NodeRegistry.listActive(reputation)` (reputation-aware, per Plan 8), the existing `ModelCatalog` — to classify, select, and forward a request, then relays the node's response back to the caller.

**Tech Stack:** Same as every prior coordinator plan (Node.js built-ins only, zero npm dependencies, no build step).

## Global Constraints

- Everything from Plan 3/6/7/8/9/10/11's Global Constraints still applies: zero npm dependencies, no placeholders, no authentication (matches every existing endpoint's trusted-LAN-scope posture).
- `servesModel` is self-reported and unverified, exactly like `localityGroup` (Plan 9) — a node can claim to serve any catalog model id with no verification that it actually does. Disclosed in the README next to the existing self-reporting caveats, not solved here.
- `POST /generate` makes a single attempt to forward to one selected node — no retry, no fallback to a different node on failure, no request queueing if the response takes a while. These are the same disclosed limitations named in the design spec (`docs/superpowers/specs/2026-08-16-request-routing-design.md`)'s "Known Limitations" section — do not add resilience machinery not asked for.
- `n_predict` on `POST /generate` defaults to 64 and is capped at 512 — bounds how long a single request can tie up a node, matching the design spec's decision.

---

### Task 1: `NodeRegistry` — `servesModel` field, and `ModelCatalog.hasModel()`

**Files:**
- Modify: `coordinator/src/registry.ts`
- Modify: `coordinator/src/catalog.ts`
- Modify: `coordinator/tests/registry.test.ts`
- Modify: `coordinator/tests/catalog.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `NodeRegistry`/`ModelCatalog` classes.
- Produces:
  ```ts
  interface NodeInfo {
    nodeId: string;
    endpoint: string;
    deviceTier: DeviceTier;
    localityGroup?: string;
    servesModel?: string;   // NEW
  }

  class NodeRegistry {
    register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string;  // servesModel param NEW
    // heartbeat(), listActive(), groupByLocality(), size() unchanged in signature
  }

  class ModelCatalog {
    hasModel(id: string): boolean;  // NEW
    // availability() unchanged
  }
  ```
  Task 2 consumes `register()`'s new fourth parameter, `listActive()`'s now-`servesModel`-carrying `NodeInfo` results, and `catalog.hasModel()`.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/registry.ts` and `coordinator/src/catalog.ts` in full first to confirm their exact current shape before extending.

Add to `coordinator/tests/registry.test.ts`:

```ts
test("register accepts an optional servesModel and it is returned via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop", undefined, "tinyllama-1.1b");
  const [node] = registry.listActive();
  assert.equal(node.servesModel, "tinyllama-1.1b");
});

test("register without a servesModel leaves it undefined via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop");
  const [node] = registry.listActive();
  assert.equal(node.servesModel, undefined);
});

test("register accepts both localityGroup and servesModel together", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop", "kitchen-mesh", "tinyllama-1.1b");
  const [node] = registry.listActive();
  assert.equal(node.localityGroup, "kitchen-mesh");
  assert.equal(node.servesModel, "tinyllama-1.1b");
});
```

Add to `coordinator/tests/catalog.test.ts`:

```ts
test("hasModel returns true for a known catalog id and false for an unknown one", () => {
  const catalog = new ModelCatalog([{ id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 }]);
  assert.equal(catalog.hasModel("tinyllama-1.1b"), true);
  assert.equal(catalog.hasModel("nonexistent-model"), false);
});
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `register()`'s fourth argument's effect isn't observable yet, `hasModel` doesn't exist.

- [ ] **Step 2: Implement**

Modify `coordinator/src/registry.ts`:
1. Add `servesModel?: string;` to the `NodeInfo` interface (alongside the existing `localityGroup?: string;`).
2. Change `register()`'s signature to `register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string` and include `servesModel` in the stored node object.
3. In `listActive()`, include `servesModel: node.servesModel` in each pushed `NodeInfo` (an `undefined` value is fine, matching how `localityGroup` already behaves — `JSON.stringify` drops `undefined` properties).

Modify `coordinator/src/catalog.ts` — add a method to the `ModelCatalog` class:

```ts
hasModel(id: string): boolean {
  return this.entries.some(entry => entry.id === id);
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 4 new tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/registry.ts coordinator/src/catalog.ts coordinator/tests/registry.test.ts coordinator/tests/catalog.test.ts
git commit -m "Add servesModel field to NodeRegistry and ModelCatalog.hasModel()"
```

---

### Task 2: `POST /generate` — classify, route, forward, respond

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: `NodeRegistry.register()`'s new fourth parameter and `listActive()`'s `servesModel` field, `ModelCatalog.hasModel()` (Task 1); the existing `SafetyClassifier`, `withTimeout`, `CLASSIFY_TIMEOUT_MS`, `readJsonBody`, `sendJson` already in `server.ts`.
- Produces: `POST /generate` route:
  ```
  POST /generate {prompt: string, modelId: string, n_predict?: integer}
    -> 200 {text: string}
    -> 400 {error: string} | {safe: false, categories: string[]}  (validation or unsafe prompt)
    -> 503 {error: string}  (no active node currently serves modelId)
    -> 502 {error: string}  (selected node unreachable or returned a malformed response)
  ```

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/server.ts` in full first — confirm the exact current `POST /nodes/register` handler and the existing `POST /classify` handler's classify/timeout/fail-closed pattern (around where `CLASSIFY_TIMEOUT_MS`/`withTimeout` are defined) before writing `/generate`, since it reuses both exactly.

Add to `coordinator/tests/server.test.ts` (check the current `startTestServer` helper's signature before writing — reuse it):

```ts
import { createServer as createHttpServer } from "node:http";

// A minimal stand-in for a swarm-node-agent's HTTP interface: responds to
// POST /complete with a canned body. Used so this test file can exercise
// /generate's routing logic without a real C++ process or model -- the
// real cross-language path is covered separately by the opt-in e2e test
// (Task 3), not here.
async function startStubNodeAgent(handler: (body: unknown) => { status: number; body: unknown }) {
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
    const { status, body: responseBody } = handler(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub node agent to bind to a port");
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

test("POST /generate classifies, routes to a matching node, and returns its response", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "Paris." } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "The capital of France is", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "Paris." });
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate returns 400 when prompt is missing", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "tinyllama-1.1b" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /generate returns 400 when modelId is not a known catalog id", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "nonexistent-model" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /generate returns 400 with n_predict out of the allowed range", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", n_predict: 9999 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /generate returns 503 when no active node serves the requested model", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});

test("POST /generate returns 502 when the selected node is unreachable", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:1", deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });
    assert.equal(res.status, 502);
  } finally {
    server.close();
  }
});

test("POST /generate excludes a reputation-ejected node from routing", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "should not be reached" } }));
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    const { nodeId } = await registerRes.json();

    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    }

    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });
    assert.equal(res.status, 503);
  } finally {
    server.close();
    stub.server.close();
  }
});
```

Note: the catalog used by `startTestServer()` must include a `tinyllama-1.1b` entry for the `modelId`-validation tests above to exercise the intended "valid id, no serving node" path rather than the "invalid id" path — check `startTestServer`'s current default `ModelCatalog` construction (it may already include this id from `DEFAULT_CATALOG` in `coordinator/src/catalog.ts` — confirm before assuming).

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `/generate` doesn't exist yet (404 instead of the expected statuses).

- [ ] **Step 2: Implement**

Add near the top of `coordinator/src/server.ts`, alongside the existing `CLASSIFY_TIMEOUT_MS` constant:

```ts
const DEFAULT_N_PREDICT = 64;
const MAX_N_PREDICT = 512;
const GENERATE_TIMEOUT_MS = 120000;
```

Add the route (place it near the existing `POST /classify` route, before the final `res.writeHead(404); res.end();` fallback):

```ts
if (method === "POST" && parts[0] === "generate" && parts.length === 1) {
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const candidate = body as Record<string, unknown>;

  if (typeof candidate.prompt !== "string") {
    sendJson(res, 400, { error: "prompt must be a string" });
    return;
  }
  if (typeof candidate.modelId !== "string" || !catalog.hasModel(candidate.modelId)) {
    sendJson(res, 400, { error: "modelId must be a known catalog model id" });
    return;
  }
  let nPredict = DEFAULT_N_PREDICT;
  if (candidate.n_predict !== undefined) {
    if (
      typeof candidate.n_predict !== "number" ||
      !Number.isInteger(candidate.n_predict) ||
      candidate.n_predict < 1 ||
      candidate.n_predict > MAX_N_PREDICT
    ) {
      sendJson(res, 400, { error: `n_predict must be an integer between 1 and ${MAX_N_PREDICT}` });
      return;
    }
    nPredict = candidate.n_predict;
  }

  try {
    const result = await withTimeout(classifier.classify(candidate.prompt), CLASSIFY_TIMEOUT_MS);
    const safe = result?.safe;
    const categories = result?.categories;
    if (typeof safe !== "boolean" || !Array.isArray(categories)) {
      throw new Error("classifier returned a malformed result");
    }
    if (!safe) {
      sendJson(res, 400, { safe: false, categories: categories.map(String) });
      return;
    }
  } catch {
    // Fail closed, matching /classify's own established behavior: a
    // classifier error (including a malformed result or a timeout) must
    // never be treated as "safe enough to route."
    sendJson(res, 400, { safe: false, categories: ["classifier_error"] });
    return;
  }

  const node = registry.listActive(reputation).find(n => n.servesModel === candidate.modelId);
  if (!node) {
    sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
    return;
  }

  try {
    const nodeRes = await fetch(`${node.endpoint}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    if (!nodeRes.ok) {
      sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
      return;
    }
    const nodeBody = await nodeRes.json();
    if (typeof nodeBody.text !== "string") {
      sendJson(res, 502, { error: "node returned a malformed response" });
      return;
    }
    sendJson(res, 200, { text: nodeBody.text });
  } catch (err) {
    console.warn(`failed to forward /generate to node ${node.endpoint}:`, err);
    sendJson(res, 502, { error: "failed to reach the selected node" });
  }
  return;
}
```

Modify the existing `POST /nodes/register` handler to also accept and validate `servesModel`, immediately after the existing `localityGroup` handling block:

```ts
let servesModel: string | undefined;
if (candidate.servesModel !== undefined) {
  if (typeof candidate.servesModel !== "string" || !catalog.hasModel(candidate.servesModel)) {
    sendJson(res, 400, { error: "servesModel must be a known catalog model id when provided" });
    return;
  }
  servesModel = candidate.servesModel;
}
const nodeId = registry.register(candidate.endpoint, candidate.deviceTier as DeviceTier, localityGroup, servesModel);
```

(This replaces the existing final two lines of that handler — the `let localityGroup` block above it is unchanged.)

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 7 new tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/server.ts coordinator/tests/server.test.ts
git commit -m "Add POST /generate: classify, route to a serving node, and forward the request"
```

---

### Task 3: `SwarmClient.generate()`, OpenAPI update, README, and an opt-in end-to-end test

**Files:**
- Modify: `coordinator/src/client.ts`
- Modify: `coordinator/src/openapi.ts`
- Create: `coordinator/tests/generate_e2e.ts`
- Modify: `coordinator/package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `POST /generate` and `POST /nodes/register`'s new `servesModel` field (Task 2).
- Produces:
  ```ts
  class SwarmClient {
    // registerNode's signature gains two new optional trailing params:
    registerNode(endpoint: string, deviceTier: "desktop" | "android" | "ios", localityGroup?: string, servesModel?: string, signal?: AbortSignal): Promise<string>;
    generate(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): Promise<{ text: string }>;
  }
  ```
  Nothing later in this plan consumes this — final deliverable.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/client.ts` in full first to confirm `registerNode`'s exact current signature (it gained a `signal?: AbortSignal` trailing parameter in Plan 11's fix round) before extending it.

Add to `coordinator/tests/client.test.ts` (reuse the existing `startTestServer` helper defined in that file):

```ts
test("SwarmClient.registerNode accepts an optional servesModel", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    const nodeId = await client.registerNode("http://127.0.0.1:50052", "desktop", undefined, "tinyllama-1.1b");
    const nodes = await client.listNodes();
    assert.equal((nodes as { nodeId: string; servesModel?: string }[])[0].servesModel, "tinyllama-1.1b");
    assert.equal(typeof nodeId, "string");
  } finally {
    server.close();
  }
});

test("SwarmClient.generate returns the generated text from a matching stub node", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "Paris." } }));
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    await client.registerNode(stub.endpoint, "desktop", undefined, "tinyllama-1.1b");

    const result = await client.generate("The capital of France is", "tinyllama-1.1b");
    assert.deepEqual(result, { text: "Paris." });
  } finally {
    server.close();
    stub.server.close();
  }
});
```

Test files in this project don't share helpers across files (see `client.test.ts`'s own copy of `startTestServer` as precedent) — add this same helper directly into `coordinator/tests/client.test.ts`, near its existing `startTestServer`:

```ts
import { createServer as createHttpServer } from "node:http";

async function startStubNodeAgent(handler: (body: unknown) => { status: number; body: unknown }) {
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
    const { status, body: responseBody } = handler(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub node agent to bind to a port");
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `registerNode` doesn't accept a `servesModel` argument's effect isn't observable yet, `generate` doesn't exist on `SwarmClient`.

- [ ] **Step 2: Implement `SwarmClient` changes**

Modify `coordinator/src/client.ts`'s `registerNode` method:

```ts
async registerNode(
  endpoint: string,
  deviceTier: "desktop" | "android" | "ios",
  localityGroup?: string,
  servesModel?: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await this.postJson("/nodes/register", { endpoint, deviceTier, localityGroup, servesModel }, signal);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`registerNode failed: ${res.status} ${detail}`);
  }
  const body = await res.json();
  return body.nodeId;
}
```

(This replaces the existing `registerNode` method — its current body already has the `!res.ok` error-detail handling from Plan 11's fix round; only the parameter list and the `postJson` call's body object change. Check the exact current `postJson` helper's signature — Plan 11's fix round added a `signal` parameter to it — and pass `signal` through the same way every other method already does.)

Add a new method, alongside the other methods, in the same style:

```ts
async generate(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): Promise<{ text: string }> {
  const res = await this.postJson("/generate", { prompt, modelId, n_predict }, signal);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`generate failed: ${res.status} ${detail}`);
  }
  return res.json();
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including both new client tests.

- [ ] **Step 4: Update the OpenAPI document**

Modify `coordinator/src/openapi.ts`:
1. Add a `servesModel` property to `/nodes/register`'s existing request body schema (alongside `localityGroup`): `servesModel: { type: "string" }`.
2. Add a new path entry:

```ts
"/generate": {
  post: {
    summary: "Classify a prompt, route it to an active node serving the requested model, and return the generated text. No inference-request endpoint existed before this; still no streaming (the response arrives complete or not at all), no retry, and no fallback to a different node on failure.",
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["prompt", "modelId"],
            properties: {
              prompt: { type: "string" },
              modelId: { type: "string" },
              n_predict: { type: "integer", minimum: 1, maximum: 512 },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Generated text", content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } } },
      "400": { description: "Invalid request, or the prompt was classified unsafe", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
      "503": { description: "No active node currently serves the requested model" },
      "502": { description: "The selected node was unreachable or returned a malformed response" },
    },
  },
},
```

Run `cd coordinator && npm test` again after this change — the drift-detection test from Plan 11 (`every path+method documented in openapi.json resolves to a real route`) will now also check `/generate`, so any mismatch between this schema addition and Task 2's actual route surfaces here.

- [ ] **Step 5: Add the opt-in end-to-end test**

Create `coordinator/tests/generate_e2e.ts` (note: this filename deliberately does NOT end in `.test.ts`, so Node's default `node --test` file discovery — used by the existing `npm test` script — does not pick it up automatically; it only runs when explicitly named):

```ts
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
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
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
    const agent: ChildProcess = spawn(AGENT_BINARY, ["--model", MODEL_PATH, "--port", String(AGENT_PORT)]);
    try {
      await waitForHealth(AGENT_PORT, 30000);

      const registry = new NodeRegistry();
      const catalog = new ModelCatalog([{ id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 }]);
      const peers = new PeerRegistry();
      const classifier = new KeywordSafetyClassifier([]);
      const reputation = new ReputationTracker();
      const server = createServer(registry, catalog, peers, classifier, reputation);
      await new Promise<void>(resolve => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected server to bind to a port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const client = new SwarmClient(baseUrl);
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
```

Modify `coordinator/package.json`'s `scripts` block to add the opt-in script:

```json
"scripts": {
  "test": "node --test",
  "test:e2e": "node --test tests/generate_e2e.ts"
}
```

- [ ] **Step 6: Run both suites**

```bash
cd coordinator && npm test
```
Expected: **PASS** — the default suite is unaffected (`generate_e2e.ts` is not picked up).

```bash
cmake --build build
cd coordinator && npm run test:e2e
```
Expected: **PASS** (not skipped) once Plan 12 is merged and the C++ build has run — this proves the real cross-language path. If Plan 12 isn't merged yet in your working tree, expect the test to report **skipped** with the reason logged, not a failure.

- [ ] **Step 7: Update README**

Add `POST /generate` to the coordinator's endpoint list (mirroring the existing bullet style), document the `servesModel` field on `POST /nodes/register` next to the existing `localityGroup` documentation (including the same self-reported-and-unverified caveat), and add a short paragraph explaining: this is the first endpoint in the repo that produces a real generated response; it requires a `swarm-node-agent` (see the C++ side's README section, added by Plan 12) to be running and registered with a matching `servesModel`; there is still no dynamic node selection, pre-warming, or streaming (name these as the next phases from the design spec, referencing `docs/superpowers/specs/2026-08-16-request-routing-design.md`).

- [ ] **Step 8: Commit**

```bash
git add coordinator/src/client.ts coordinator/src/openapi.ts coordinator/tests/generate_e2e.ts coordinator/tests/client.test.ts coordinator/package.json README.md
git commit -m "Add SwarmClient.generate(), OpenAPI coverage for /generate, and an opt-in end-to-end test"
```

---

## What this plan does not do

Does not implement dynamic, coordinator-driven pipeline assembly, background pre-warming, or demand-based autoscaling — Phases B and C of the design spec, not yet designed in detail. Does not implement token streaming — Phase D. Does not verify that a node's self-reported `servesModel` is accurate (matches the same disclosed, unsolved posture as `localityGroup`'s self-reporting). Does not add retry, fallback, or queueing to `/generate` — single attempt, fail loud, matching the design spec's disclosed limitations.
