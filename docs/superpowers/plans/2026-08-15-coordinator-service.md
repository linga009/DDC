# Coordinator Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hostable coordinator service that nodes register with, that tracks which nodes are currently active, and that computes which catalog models the current active-node count can serve — the metadata/control-plane layer the spec's Model Catalog & Progressive Unlocking section describes. It does not itself run inference; it decides who's available and what's servable.

**Architecture:** A dependency-free Node.js/TypeScript HTTP service, independent of the C++ inference engine (Plans 1-2) — different language, different process, communicating over HTTP. Three small units: `NodeRegistry` (who's online), `ModelCatalog` (given N active nodes, what's servable), and a thin HTTP server wiring both to REST endpoints. Node.js (v22+) runs `.ts` files natively (verified on this machine: no `ts-node`, no build step, no `tsc` needed), so this plan intentionally has zero npm dependencies — no `npm install`, nothing to fetch from a registry.

**Tech Stack:** Node.js (built-in `node:http`, `node:test`, `node:assert/strict`, `node:crypto`), TypeScript via Node's native type-stripping (no transpiler).

## Global Constraints

- Zero npm dependencies for this plan — everything is a Node.js built-in. If a later task genuinely can't be done without a package, stop and report NEEDS_CONTEXT rather than silently adding one.
- No placeholders, TODOs, or stubbed-out error handling.
- The catalog's node-count thresholds in this plan are small, illustrative dev-scale numbers (single digits), not the spec's real-world tens/hundreds/thousands — chosen so tests can actually exercise crossing a threshold without simulating hundreds of fake nodes. This mirrors Plan 1's own honest note that real thresholds need calibration against measured throughput; it is not this plan's job to guess real-world numbers.
- Time-dependent logic (heartbeat expiry) must take an injectable clock (a function returning the current time), not call `Date.now()`/`setTimeout` directly inside the logic under test — tests must be able to simulate time passing deterministically, not sleep for real.
- This plan is independent of Plans 1-2 (the C++ inference engine) — it does not call into, build, or depend on `core/` or `vendor/llama.cpp` in any way. It can be developed and tested entirely on its own.

---

### Task 1: `NodeRegistry` — node registration and liveness tracking

**Files:**
- Create: `coordinator/src/registry.ts`
- Create: `coordinator/tests/registry.test.ts`
- Create: `coordinator/package.json`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  ```ts
  type DeviceTier = "desktop" | "android" | "ios";

  interface NodeInfo {
    nodeId: string;
    endpoint: string;
    deviceTier: DeviceTier;
  }

  class NodeRegistry {
    constructor(clock?: () => number);          // clock defaults to Date.now
    register(endpoint: string, deviceTier: DeviceTier): string;   // returns nodeId
    heartbeat(nodeId: string): boolean;          // false if nodeId unknown
    listActive(timeoutMs?: number): NodeInfo[];  // default timeoutMs: 30000
  }
  ```
  Task 2 (`ModelCatalog`) consumes `listActive().length` as its active-node count. Task 3 (the HTTP server) consumes the whole class directly.

- [ ] **Step 1: Write `coordinator/package.json`**

```json
{
  "name": "swarm-coordinator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `coordinator/tests/registry.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeRegistry } from "../src/registry.ts";

test("register returns a nodeId, and the node is immediately active", () => {
  const registry = new NodeRegistry();
  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  assert.equal(typeof nodeId, "string");
  assert.ok(nodeId.length > 0);

  const active = registry.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].nodeId, nodeId);
  assert.equal(active[0].endpoint, "127.0.0.1:50052");
  assert.equal(active[0].deviceTier, "desktop");
});

test("heartbeat on a known node returns true", () => {
  const registry = new NodeRegistry();
  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  assert.equal(registry.heartbeat(nodeId), true);
});

test("heartbeat on an unknown node returns false", () => {
  const registry = new NodeRegistry();

  assert.equal(registry.heartbeat("does-not-exist"), false);
});

test("a node past the heartbeat timeout is excluded from listActive", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);

  const nodeId = registry.register("127.0.0.1:50052", "desktop");
  assert.equal(registry.listActive(30000).length, 1);

  now = 30001; // just past the 30s timeout, with no heartbeat in between
  assert.equal(registry.listActive(30000).length, 0);

  now = 30001;
  registry.heartbeat(nodeId); // heartbeat refreshes lastSeen to `now`
  assert.equal(registry.listActive(30000).length, 1);

  now = 60002; // 30001 seconds past the refreshed heartbeat
  assert.equal(registry.listActive(30000).length, 0);
});

test("multiple nodes are tracked independently", () => {
  const registry = new NodeRegistry();
  const a = registry.register("127.0.0.1:50052", "desktop");
  const b = registry.register("127.0.0.1:50053", "android");

  assert.notEqual(a, b);
  assert.equal(registry.listActive().length, 2);
});
```

Run:
```bash
cd coordinator && node --test tests/registry.test.ts
```
Expected: **FAIL** — `src/registry.ts` doesn't exist yet, so the import fails and every test errors.

- [ ] **Step 3: Implement `NodeRegistry`**

Create `coordinator/src/registry.ts`:
```ts
import { randomUUID } from "node:crypto";

export type DeviceTier = "desktop" | "android" | "ios";

export interface NodeInfo {
  nodeId: string;
  endpoint: string;
  deviceTier: DeviceTier;
}

interface StoredNode extends NodeInfo {
  lastSeen: number;
}

export class NodeRegistry {
  private readonly clock: () => number;
  private readonly nodes = new Map<string, StoredNode>();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  register(endpoint: string, deviceTier: DeviceTier): string {
    const nodeId = randomUUID();
    this.nodes.set(nodeId, { nodeId, endpoint, deviceTier, lastSeen: this.clock() });
    return nodeId;
  }

  heartbeat(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }
    node.lastSeen = this.clock();
    return true;
  }

  listActive(timeoutMs = 30000): NodeInfo[] {
    const now = this.clock();
    const active: NodeInfo[] = [];
    for (const node of this.nodes.values()) {
      if (now - node.lastSeen <= timeoutMs) {
        active.push({ nodeId: node.nodeId, endpoint: node.endpoint, deviceTier: node.deviceTier });
      }
    }
    return active;
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd coordinator && node --test tests/registry.test.ts
```
Expected: **PASS** — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add coordinator/package.json coordinator/src/registry.ts coordinator/tests/registry.test.ts
git commit -m "Add NodeRegistry: node registration and heartbeat-based liveness tracking"
```

---

### Task 2: `ModelCatalog` — capacity-gated model availability

**Files:**
- Create: `coordinator/src/catalog.ts`
- Create: `coordinator/tests/catalog.test.ts`

**Interfaces:**
- Consumes: nothing directly (takes a plain node count, not `NodeRegistry` itself — keeps it independently testable without needing a registry instance).
- Produces:
  ```ts
  interface CatalogEntry {
    id: string;             // e.g. "tinyllama-1.1b"
    displayName: string;    // e.g. "TinyLlama 1.1B"
    minActiveNodes: number; // capacity threshold to unlock
  }

  interface AvailabilityEntry extends CatalogEntry {
    available: boolean;
  }

  class ModelCatalog {
    constructor(entries?: CatalogEntry[]);  // defaults to the built-in dev-scale table below
    availability(activeNodeCount: number): AvailabilityEntry[];
  }
  ```
  Task 3 (the HTTP server) consumes `ModelCatalog` directly, calling `availability(registry.listActive().length)`.

- [ ] **Step 1: Write the failing tests**

Create `coordinator/tests/catalog.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "../src/catalog.ts";

test("default catalog has four tiers with increasing thresholds, tier 0 always available", () => {
  const catalog = new ModelCatalog();
  const result = catalog.availability(0);

  assert.equal(result.length, 4);
  assert.equal(result[0].minActiveNodes, 0);
  assert.equal(result[0].available, true);
  assert.equal(result[1].available, false);
  assert.equal(result[2].available, false);
  assert.equal(result[3].available, false);
});

test("models unlock exactly at their threshold, not one below", () => {
  const catalog = new ModelCatalog([
    { id: "small", displayName: "Small", minActiveNodes: 0 },
    { id: "medium", displayName: "Medium", minActiveNodes: 3 },
  ]);

  assert.equal(catalog.availability(2).find(e => e.id === "medium")!.available, false);
  assert.equal(catalog.availability(3).find(e => e.id === "medium")!.available, true);
  assert.equal(catalog.availability(4).find(e => e.id === "medium")!.available, true);
});

test("custom catalog entries are used verbatim, replacing the default table", () => {
  const catalog = new ModelCatalog([
    { id: "only-one", displayName: "Only One", minActiveNodes: 5 },
  ]);

  const result = catalog.availability(10);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "only-one");
});
```

Run:
```bash
cd coordinator && node --test tests/catalog.test.ts
```
Expected: **FAIL** — `src/catalog.ts` doesn't exist yet.

- [ ] **Step 2: Implement `ModelCatalog`**

Create `coordinator/src/catalog.ts`:
```ts
export interface CatalogEntry {
  id: string;
  displayName: string;
  minActiveNodes: number;
}

export interface AvailabilityEntry extends CatalogEntry {
  available: boolean;
}

// Dev-scale thresholds for local testing only -- NOT the spec's real-world
// tens/hundreds/thousands. Recalibrate against measured per-node throughput
// before these numbers mean anything in production (see Plan 1's Known Risks
// and this plan's Global Constraints for why).
const DEFAULT_CATALOG: CatalogEntry[] = [
  { id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 },
  { id: "small-7b", displayName: "Small 7-8B dense model", minActiveNodes: 2 },
  { id: "mixtral-8x7b", displayName: "Mixtral 8x7B", minActiveNodes: 5 },
  { id: "mixtral-8x22b", displayName: "Mixtral 8x22B", minActiveNodes: 10 },
];

export class ModelCatalog {
  private readonly entries: CatalogEntry[];

  constructor(entries: CatalogEntry[] = DEFAULT_CATALOG) {
    this.entries = entries;
  }

  availability(activeNodeCount: number): AvailabilityEntry[] {
    return this.entries.map(entry => ({
      ...entry,
      available: activeNodeCount >= entry.minActiveNodes,
    }));
  }
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && node --test tests/catalog.test.ts
```
Expected: **PASS** — all 3 tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/catalog.ts coordinator/tests/catalog.test.ts
git commit -m "Add ModelCatalog: capacity-gated model availability"
```

---

### Task 3: HTTP server wiring registry and catalog together

**Files:**
- Create: `coordinator/src/server.ts`
- Create: `coordinator/src/main.ts`
- Create: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: `NodeRegistry` (Task 1) and `ModelCatalog` (Task 2) directly.
- Produces:
  ```ts
  function createServer(registry: NodeRegistry, catalog: ModelCatalog): import("node:http").Server;
  ```
  `main.ts` is the only consumer within this plan (it starts the server on a real port); no later plan in this repo yet depends on this interface, but the spec's Federation plan will eventually call this service's HTTP API from other coordinator instances.

- [ ] **Step 1: Write the failing tests**

Create `coordinator/tests/server.test.ts`. This is an integration test: it starts a real server on an OS-assigned ephemeral port (port 0) and makes real HTTP requests with the built-in `fetch`.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ModelCatalog } from "../src/catalog.ts";

async function startTestServer() {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog([
    { id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 },
    { id: "small-7b", displayName: "Small 7-8B dense model", minActiveNodes: 1 },
  ]);
  const server = createServer(registry, catalog);

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a real port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, registry };
}

test("POST /nodes/register returns a nodeId and the node appears in the catalog's active count", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });
    assert.equal(registerRes.status, 200);
    const { nodeId } = await registerRes.json();
    assert.equal(typeof nodeId, "string");

    const catalogRes = await fetch(`${baseUrl}/catalog`);
    assert.equal(catalogRes.status, 200);
    const catalog = await catalogRes.json();
    const smallModel = catalog.find((e: any) => e.id === "small-7b");
    assert.equal(smallModel.available, true); // 1 active node, threshold is 1
  } finally {
    server.close();
  }
});

test("POST /nodes/:nodeId/heartbeat returns 204 for a known node and 404 for an unknown one", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await registerRes.json();

    const goodHeartbeat = await fetch(`${baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST" });
    assert.equal(goodHeartbeat.status, 204);

    const badHeartbeat = await fetch(`${baseUrl}/nodes/not-a-real-id/heartbeat`, { method: "POST" });
    assert.equal(badHeartbeat.status, 404);
  } finally {
    server.close();
  }
});

test("GET /nodes lists active nodes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });

    const res = await fetch(`${baseUrl}/nodes`);
    const nodes = await res.json();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].endpoint, "127.0.0.1:50052");
  } finally {
    server.close();
  }
});

test("GET /catalog with zero active nodes only shows the zero-threshold model available", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/catalog`);
    const catalog = await res.json();
    assert.equal(catalog.find((e: any) => e.id === "tinyllama-1.1b").available, true);
    assert.equal(catalog.find((e: any) => e.id === "small-7b").available, false);
  } finally {
    server.close();
  }
});
```

Run:
```bash
cd coordinator && node --test tests/server.test.ts
```
Expected: **FAIL** — `src/server.ts` doesn't exist yet.

- [ ] **Step 2: Implement the server**

Create `coordinator/src/server.ts`:
```ts
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { NodeRegistry, DeviceTier } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog) {
  return createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "POST" && parts[0] === "nodes" && parts.length === 2 && parts[1] === "register") {
      const body = (await readJsonBody(req)) as { endpoint?: string; deviceTier?: DeviceTier };
      if (!body.endpoint || !body.deviceTier) {
        sendJson(res, 400, { error: "endpoint and deviceTier are required" });
        return;
      }
      const nodeId = registry.register(body.endpoint, body.deviceTier);
      sendJson(res, 200, { nodeId });
      return;
    }

    if (method === "POST" && parts[0] === "nodes" && parts.length === 3 && parts[2] === "heartbeat") {
      const ok = registry.heartbeat(parts[1]);
      if (!ok) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && parts[0] === "nodes" && parts.length === 1) {
      sendJson(res, 200, registry.listActive());
      return;
    }

    if (method === "GET" && parts[0] === "catalog" && parts.length === 1) {
      sendJson(res, 200, catalog.availability(registry.listActive().length));
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
```

If Node's native TypeScript handling in this project's actual Node version rejects any syntax used above (e.g. certain type-only import forms), adjust to whatever subset the verified-working `node --test` setup from Task 1 accepts — that's the source of truth, not this snippet.

- [ ] **Step 3: Write the entry point**

Create `coordinator/src/main.ts`:
```ts
import { createServer } from "./server.ts";
import { NodeRegistry } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";

const port = Number(process.env.PORT ?? 8080);
const registry = new NodeRegistry();
const catalog = new ModelCatalog();
const server = createServer(registry, catalog);

server.listen(port, () => {
  console.log(`coordinator listening on port ${port}`);
});
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd coordinator && node --test tests/
```
Expected: **PASS** — all tests across all three test files (registry, catalog, server).

- [ ] **Step 5: Manually verify the entry point runs**

```bash
cd coordinator && PORT=8090 timeout 3 node src/main.ts; echo "exit code: $?"
```
Expected: prints `coordinator listening on port 8090` before being killed by `timeout`.

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/server.ts coordinator/src/main.ts coordinator/tests/server.test.ts
git commit -m "Add coordinator HTTP server wiring NodeRegistry and ModelCatalog together"
```

---

## What this plan does not do

Does not persist node/registry state across restarts (in-memory only). Does not do any actual pipeline assembly or request routing to nodes — it only tracks who's online and what's servable. Does not integrate with the C++ inference engine or the RPC mechanism from Plan 2 in any way; that integration (the coordinator actually handing out a set of RPC endpoints for a client to use) is future work once both sides exist. Does not add authentication to its own API — anyone who can reach it can register fake nodes or query the catalog; matches this plan's LAN/trusted-network scope, same caveat as Plan 2's RPC backend.
