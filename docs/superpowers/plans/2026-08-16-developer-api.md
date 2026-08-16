# Developer API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the coordinator's existing REST API — already the spec's "developer-facing REST/gRPC endpoint on each instance... the chat app is simply its first client, not a special case" — actually discoverable and easy to build against for external developers, per the project's open-source-crowd-contribution goal.

**Scope correction, stated up front:** every coordinator endpoint that exists today (node/peer registry, capacity, catalog, safety classification, reputation, locality) already collectively *is* the developer API described in the spec's API Gateway component — this plan does not add new capability endpoints. It also cannot add a "submit a prompt, get inference back" endpoint, because no request-routing/pipeline-assembly system exists anywhere in this repo yet (the same gap Plans 8, 9, and 10 have each already documented — nothing has changed since). What this plan actually builds: a machine-readable API specification (`GET /openapi.json`) describing every route that exists today, and a minimal typed TypeScript client (`SwarmClient`) wrapping them — so a developer can either point standard OpenAPI tooling (Swagger UI, codegen) at a running instance, or import one small dependency-free file instead of hand-writing `fetch` calls against 14 endpoints.

**Architecture:** `coordinator/src/openapi.ts` exports a single static `const` object (the OpenAPI 3.0 document), served as-is via a new fixed route, `GET /openapi.json`, following the same pattern established by Plan 10's static routes (a hardcoded, non-parameterized path). `coordinator/src/client.ts` exports a `SwarmClient` class — a thin wrapper with one typed method per endpoint, constructed with a base URL, using native `fetch` only.

**Tech Stack:** Same as every prior coordinator plan (Node.js built-ins only, zero npm dependencies, no build step, no code-gen tooling).

## Global Constraints

- Everything from Plan 3/6/7/8/9/10's Global Constraints still applies: zero npm dependencies, no placeholders, no authentication (matches every existing endpoint's trusted-LAN-scope posture — `/openapi.json` describes public, non-sensitive route shapes, so this is not a new exposure).
- The OpenAPI document is **hand-written and static**, not generated from the route code at build or run time. This means it can drift from the real routes if a future plan changes an endpoint without updating it — a real, disclosed risk, not silently assumed safe. Task 1 mitigates this the only way available without adding tooling: a test that walks every path in the OpenAPI document and asserts a live request to it doesn't 404 (proving the documented surface is at least real), which would fail loudly if a route were renamed or removed without updating the doc — it cannot catch a request/response *shape* drifting, only a path disappearing.
- `SwarmClient` wraps existing endpoints only — it does not add retry logic, timeouts beyond what a caller supplies, or connection pooling. A thin wrapper, not a resilience layer.

---

### Task 1: `GET /openapi.json` — machine-readable API specification

**Files:**
- Create: `coordinator/src/openapi.ts`
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const openApiDocument: object` from `coordinator/src/openapi.ts`; new route `GET /openapi.json` → 200, the document as JSON. Task 2 does not depend on this file.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/server.ts` in full first to confirm the exact current list of routes (it has grown across every prior plan) and confirm `GET /openapi.json` (`parts.length === 1 && parts[0] === "openapi.json"`) doesn't collide with any existing route.

Add to `coordinator/tests/server.test.ts` (check the current `startTestServer` helper's signature before writing):

```ts
import { openApiDocument } from "../src/openapi.ts";

test("GET /openapi.json serves the OpenAPI document", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.openapi, "3.0.3");
    assert.ok(body.paths["/catalog"], "expected /catalog to be documented");
    assert.ok(body.paths["/nodes/{nodeId}/reputation"], "expected the reputation path template to be documented");
  } finally {
    server.close();
  }
});

test("every path+method documented in openapi.json resolves to a real route (not a 404)", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    // Register one node and one peer first, so path-templated routes
    // (/nodes/{nodeId}/..., /peers/{peerId}/...) have a real ID to substitute
    // in and can be checked against their real (non-404) status rather than
    // failing for the unrelated reason of "no such id".
    const nodeRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await nodeRes.json();
    const peerRes = await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:9999" }),
    });
    const { peerId } = await peerRes.json();

    const substitute = (path: string) => path.replace("{nodeId}", nodeId).replace("{peerId}", peerId);

    for (const [path, methods] of Object.entries(openApiDocument.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(methods)) {
        const url = `${baseUrl}${substitute(path)}`;
        const res = await fetch(url, {
          method: method.toUpperCase(),
          headers: method.toUpperCase() === "POST" ? { "content-type": "application/json" } : undefined,
          body: method.toUpperCase() === "POST" ? "{}" : undefined,
        });
        assert.notEqual(res.status, 404, `${method.toUpperCase()} ${path} (documented in openapi.json) returned 404 -- route missing or path template wrong`);
      }
    }
  } finally {
    server.close();
  }
});
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `openapi.ts` doesn't exist yet, `GET /openapi.json` 404s.

- [ ] **Step 2: Implement**

Create `coordinator/src/openapi.ts`:

```ts
export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "swarm-llm coordinator API",
    version: "0.1.0",
    description:
      "Federated LLM inference coordinator: node/peer registry, capacity " +
      "tracking, model catalog gating, safety classification, reputation, " +
      "and locality grouping. Does not yet expose an inference-request " +
      "endpoint -- no request-routing system exists in this repo yet.",
  },
  paths: {
    "/nodes/register": {
      post: {
        summary: "Register a node",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "deviceTier"],
                properties: {
                  endpoint: { type: "string" },
                  deviceTier: { type: "string", enum: ["desktop", "android", "ios"] },
                  localityGroup: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { nodeId: { type: "string" } } } } } },
          "400": { description: "Invalid request body" },
        },
      },
    },
    "/nodes/{nodeId}/heartbeat": {
      post: {
        summary: "Refresh a node's liveness",
        responses: { "204": { description: "Heartbeat accepted" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation/agree": {
      post: {
        summary: "Record that a node's output agreed with a redundant spot-check",
        responses: { "204": { description: "Recorded" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation/disagree": {
      post: {
        summary: "Record that a node's output disagreed with a redundant spot-check",
        responses: { "204": { description: "Recorded" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation": {
      get: {
        summary: "Get a node's reputation stats",
        responses: {
          "200": {
            description: "Reputation stats",
            content: { "application/json": { schema: { type: "object", properties: { agreements: { type: "integer" }, disagreements: { type: "integer" }, trusted: { type: "boolean" } } } } },
          },
          "404": { description: "Unknown nodeId" },
        },
      },
    },
    "/nodes": {
      get: {
        summary: "List currently active nodes",
        responses: { "200": { description: "Active nodes", content: { "application/json": { schema: { type: "array" } } } } },
      },
    },
    "/nodes/locality": {
      get: {
        summary: "List active nodes grouped by self-reported locality",
        responses: { "200": { description: "Nodes grouped by locality group", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/capacity": {
      get: {
        summary: "This instance's active node count (used by federated peers)",
        responses: { "200": { description: "Capacity", content: { "application/json": { schema: { type: "object", properties: { activeNodes: { type: "integer" } } } } } } },
      },
    },
    "/peers/register": {
      post: {
        summary: "Register a federated peer coordinator instance",
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string", format: "uri" } } } } },
        },
        responses: {
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { peerId: { type: "string" } } } } } },
          "400": { description: "Invalid endpoint" },
        },
      },
    },
    "/peers/{peerId}/heartbeat": {
      post: {
        summary: "Refresh a peer's liveness",
        responses: { "204": { description: "Heartbeat accepted" }, "404": { description: "Unknown peerId" } },
      },
    },
    "/peers": {
      get: {
        summary: "List currently active peers",
        responses: { "200": { description: "Active peers", content: { "application/json": { schema: { type: "array" } } } } },
      },
    },
    "/peers/{peerId}": {
      delete: {
        summary: "Deregister a peer",
        responses: { "204": { description: "Deregistered" }, "404": { description: "Unknown peerId" } },
      },
    },
    "/catalog": {
      get: {
        summary: "List models with availability gated on active node count (local + federated)",
        responses: { "200": { description: "Catalog", content: { "application/json": { schema: { type: "array" } } } } },
      },
    },
    "/classify": {
      post: {
        summary: "Safety-classify a prompt (does not run inference; shipped classifier has zero rules by default)",
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Classification result", content: { "application/json": { schema: { type: "object", properties: { safe: { type: "boolean" }, categories: { type: "array", items: { type: "string" } } } } } } },
          "400": { description: "Invalid request body" },
        },
      },
    },
  },
};
```

Add to `coordinator/src/server.ts` (import `openApiDocument` from `./openapi.ts`, and add a route — place it near the other fixed-path GET routes from Plan 10):

```ts
if (method === "GET" && parts.length === 1 && parts[0] === "openapi.json") {
  sendJson(res, 200, openApiDocument);
  return;
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including both new tests. The second test will fail loudly and specifically (naming the exact undocumented-or-mismatched path+method) if the OpenAPI document and the real routes have drifted apart — pay attention to this if it fails; it means Step 2's document doesn't match Step 2's route addition, or an existing route was missed.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/openapi.ts coordinator/src/server.ts coordinator/tests/server.test.ts
git commit -m "Add GET /openapi.json: machine-readable API specification"
```

---

### Task 2: `SwarmClient` — minimal typed TypeScript client

**Files:**
- Create: `coordinator/src/client.ts`
- Create: `coordinator/tests/client.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing from Task 1 — talks to the same HTTP routes directly, independent of the OpenAPI document.
- Produces:
  ```ts
  export class SwarmClient {
    constructor(baseUrl: string);
    registerNode(endpoint: string, deviceTier: "desktop" | "android" | "ios", localityGroup?: string): Promise<string>;
    heartbeat(nodeId: string): Promise<boolean>;
    recordAgreement(nodeId: string): Promise<boolean>;
    recordDisagreement(nodeId: string): Promise<boolean>;
    getReputation(nodeId: string): Promise<{ agreements: number; disagreements: number; trusted: boolean } | null>;
    listNodes(): Promise<unknown[]>;
    listNodesByLocality(): Promise<Record<string, unknown[]>>;
    getCapacity(): Promise<number>;
    registerPeer(endpoint: string): Promise<string>;
    peerHeartbeat(peerId: string): Promise<boolean>;
    listPeers(): Promise<unknown[]>;
    deregisterPeer(peerId: string): Promise<boolean>;
    getCatalog(): Promise<unknown[]>;
    classify(prompt: string): Promise<{ safe: boolean; categories: string[] }>;
  }
  ```
  Nothing later in this plan consumes this — it's the final deliverable.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/server.ts` and `coordinator/tests/server.test.ts` in full first to confirm exact current request/response shapes for every endpoint this client wraps.

Create `coordinator/tests/client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ModelCatalog } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";
import { KeywordSafetyClassifier } from "../src/safety_classifier.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import { SwarmClient } from "../src/client.ts";

async function startTestServer() {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog();
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
  return { server, baseUrl };
}

test("SwarmClient registers a node and lists it", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    const nodeId = await client.registerNode("127.0.0.1:50052", "desktop");
    assert.equal(typeof nodeId, "string");

    const nodes = await client.listNodes();
    assert.equal((nodes as { nodeId: string }[]).length, 1);
    assert.equal((nodes as { nodeId: string }[])[0].nodeId, nodeId);
  } finally {
    server.close();
  }
});

test("SwarmClient heartbeat returns true for a known node and false for an unknown one", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    const nodeId = await client.registerNode("127.0.0.1:50052", "desktop");
    assert.equal(await client.heartbeat(nodeId), true);
    assert.equal(await client.heartbeat("never-registered"), false);
  } finally {
    server.close();
  }
});

test("SwarmClient records reputation events and reads them back", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    const nodeId = await client.registerNode("127.0.0.1:50052", "desktop");
    assert.equal(await client.recordAgreement(nodeId), true);
    assert.equal(await client.recordDisagreement(nodeId), true);

    const stats = await client.getReputation(nodeId);
    assert.deepEqual(stats, { agreements: 1, disagreements: 1, trusted: true });

    assert.equal(await client.getReputation("never-registered"), null);
  } finally {
    server.close();
  }
});

test("SwarmClient reads capacity and catalog", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    assert.equal(await client.getCapacity(), 0);

    await client.registerNode("127.0.0.1:50052", "desktop");
    assert.equal(await client.getCapacity(), 1);

    const catalog = await client.getCatalog();
    assert.ok(Array.isArray(catalog));
    assert.ok(catalog.length > 0);
  } finally {
    server.close();
  }
});

test("SwarmClient lists nodes grouped by locality", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    await client.registerNode("127.0.0.1:50052", "desktop", "kitchen-mesh");
    const groups = await client.listNodesByLocality();
    assert.equal((groups["kitchen-mesh"] as unknown[]).length, 1);
  } finally {
    server.close();
  }
});

test("SwarmClient registers, heartbeats, lists, and deregisters a peer", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    const peerId = await client.registerPeer("http://127.0.0.1:9999");
    assert.equal(typeof peerId, "string");

    assert.equal(await client.peerHeartbeat(peerId), true);

    const peers = await client.listPeers();
    assert.equal((peers as { peerId: string }[]).length, 1);

    assert.equal(await client.deregisterPeer(peerId), true);
    assert.equal((await client.listPeers()).length, 0);
  } finally {
    server.close();
  }
});

test("SwarmClient classifies a prompt", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    const result = await client.classify("hello");
    assert.deepEqual(result, { safe: true, categories: [] });
  } finally {
    server.close();
  }
});
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `coordinator/src/client.ts` doesn't exist yet.

- [ ] **Step 2: Implement**

Create `coordinator/src/client.ts`:

```ts
export class SwarmClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async registerNode(endpoint: string, deviceTier: "desktop" | "android" | "ios", localityGroup?: string): Promise<string> {
    const res = await this.postJson("/nodes/register", { endpoint, deviceTier, localityGroup });
    if (!res.ok) {
      throw new Error(`registerNode failed: ${res.status}`);
    }
    const body = await res.json();
    return body.nodeId;
  }

  async heartbeat(nodeId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST" });
    return res.status === 204;
  }

  async recordAgreement(nodeId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    return res.status === 204;
  }

  async recordDisagreement(nodeId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    return res.status === 204;
  }

  async getReputation(nodeId: string): Promise<{ agreements: number; disagreements: number; trusted: boolean } | null> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation`);
    if (res.status === 404) {
      return null;
    }
    return res.json();
  }

  async listNodes(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/nodes`);
    return res.json();
  }

  async listNodesByLocality(): Promise<Record<string, unknown[]>> {
    const res = await fetch(`${this.baseUrl}/nodes/locality`);
    return res.json();
  }

  async getCapacity(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/capacity`);
    const body = await res.json();
    return body.activeNodes;
  }

  async registerPeer(endpoint: string): Promise<string> {
    const res = await this.postJson("/peers/register", { endpoint });
    if (!res.ok) {
      throw new Error(`registerPeer failed: ${res.status}`);
    }
    const body = await res.json();
    return body.peerId;
  }

  async peerHeartbeat(peerId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}/heartbeat`, { method: "POST" });
    return res.status === 204;
  }

  async listPeers(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/peers`);
    return res.json();
  }

  async deregisterPeer(peerId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}`, { method: "DELETE" });
    return res.status === 204;
  }

  async getCatalog(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/catalog`);
    return res.json();
  }

  async classify(prompt: string): Promise<{ safe: boolean; categories: string[] }> {
    const res = await this.postJson("/classify", { prompt });
    return res.json();
  }
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 7 new client tests.

- [ ] **Step 4: Update README**

Add a "Developer API" section to `README.md` (place it near the existing "Coordinator service" section), documenting: `GET /openapi.json` exists and what it's for (point standard OpenAPI tooling at a running instance); `coordinator/src/client.ts`'s `SwarmClient` exists as a minimal reference implementation developers can copy or import directly (it's plain TypeScript, zero dependencies, works with native Node.js execution); and repeat, briefly, that no inference-request endpoint exists yet.

- [ ] **Step 5: Commit**

```bash
git add coordinator/src/client.ts coordinator/tests/client.test.ts README.md
git commit -m "Add SwarmClient: minimal typed TypeScript client for the coordinator API"
```

---

## What this plan does not do

Does not add any new capability endpoint — every route the OpenAPI document describes and the client wraps already existed before this plan. Does not add an inference-request endpoint (no request-routing system exists yet — same gap named in Plans 8, 9, and 10). Does not add authentication, API keys, or rate limiting (matches every existing endpoint's no-auth, trusted-LAN-scope posture). Does not generate the OpenAPI document from route code automatically — it is hand-written and can drift; Task 1's second test only catches a path disappearing, not a request/response shape changing without the doc being updated.
