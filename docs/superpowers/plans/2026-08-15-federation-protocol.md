# Federation Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let independently-run coordinator instances (Plan 3) peer with each other and report their capacity, so an instance with insufficient local node count can factor in a federated partner's capacity when deciding whether a catalog model is available — the mechanism the spec's Federation Model section describes, at the scope this plan actually builds: capacity aggregation and peer lifecycle management, not cross-instance request routing (see below).

**Architecture:** Two new units mirroring Plan 3's existing pattern exactly: `PeerRegistry` (peer instance registration/liveness — structurally identical to `NodeRegistry`, kept as a separate class because a "peer" is a different concept from a "node" even though the tracking logic is the same shape, matching this project's established practice of small focused units over premature shared abstractions) and a `GET /capacity` endpoint every instance exposes (a lightweight, unauthenticated capacity report: how many active nodes this instance currently has). `GET /catalog` becomes federation-aware: it sums local active-node count with each live peer's reported capacity (fetched via a real HTTP call to that peer's `/capacity` endpoint) before computing model availability.

**Deliberate scope boundary:** this plan aggregates *capacity numbers* across federated instances so catalog availability reflects the combined swarm, not just the local one. It does **not** implement cross-instance *request routing* (an instance handing a client off to a peer's nodes to actually run inference) — that requires the coordinator to know about and broker access to a peer's compute nodes directly, which is materially more complex (trust, node-endpoint exposure across instances, routing logic) and is real follow-on work, not attempted here. This plan proves instances can discover each other's capacity and factor it in, which is the foundation that routing would build on.

**Tech Stack:** Same as Plan 3 (Node.js built-ins only — `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, built-in `fetch` — zero npm dependencies).

## Global Constraints

- Everything from Plan 3's Global Constraints still applies: zero npm dependencies, no placeholders, injectable clock for time-dependent logic, dev-scale numbers are illustrative.
- No authentication on `/peers/*` or `/capacity` — matches Plan 3's already-disclosed LAN/trusted-network scope. A production federation layer would need to authenticate peers before trusting their capacity reports (a malicious or misconfigured peer could report false high capacity to make unavailable models appear available); this plan does not add that, consistent with Plan 3's existing no-auth stance, and is named as a known gap, not silently assumed safe.
- `GET /capacity` and peer capacity fetches must have a timeout — a hung or unreachable peer must not block `GET /catalog` for the whole instance. Node's built-in `fetch` supports this via `AbortSignal.timeout(ms)`.
- A peer that fails to respond (timeout, connection refused, non-200) contributes 0 to the aggregate capacity for that request — federation degrades gracefully, it does not fail the whole catalog computation.

---

### Task 1: `PeerRegistry` — peer instance registration and liveness

**Files:**
- Create: `coordinator/src/peer_registry.ts`
- Create: `coordinator/tests/peer_registry.test.ts`

**Interfaces:**
- Consumes: nothing (same shape as `NodeRegistry`, independent unit).
- Produces:
  ```ts
  interface PeerInfo {
    peerId: string;
    endpoint: string;  // base URL of the peer instance, e.g. "http://192.168.1.50:8080"
  }

  class PeerRegistry {
    constructor(clock?: () => number);
    register(endpoint: string): string;        // returns peerId
    heartbeat(peerId: string): boolean;         // false if peerId unknown or expired
    deregister(peerId: string): boolean;        // false if peerId unknown; explicit removal
    listActive(): PeerInfo[];
  }
  ```
  Task 2 consumes this directly, iterating `listActive()` to fetch each peer's capacity.

- [ ] **Step 1: Write the failing tests**

Create `coordinator/tests/peer_registry.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerRegistry } from "../src/peer_registry.ts";

test("register returns a peerId, and the peer is immediately active", () => {
  const registry = new PeerRegistry();
  const peerId = registry.register("http://192.168.1.50:8080");

  assert.equal(typeof peerId, "string");
  const active = registry.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].peerId, peerId);
  assert.equal(active[0].endpoint, "http://192.168.1.50:8080");
});

test("heartbeat before expiry refreshes lastSeen and keeps the peer active past the original window", () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080");

  // Heartbeat while still well within the 30s window (not yet expired).
  now = 20000;
  assert.equal(registry.heartbeat(peerId), true);

  // 45s after registration -- past the ORIGINAL window, but only 25s after
  // the heartbeat refreshed lastSeen, so still within a fresh 30s window.
  // If the heartbeat hadn't refreshed lastSeen, this peer would already be
  // expired (45000 - 0 > 30000).
  now = 45000;
  assert.equal(registry.listActive().length, 1);
});

test("heartbeat on an unknown peer returns false", () => {
  const registry = new PeerRegistry();
  assert.equal(registry.heartbeat("does-not-exist"), false);
});

test("a peer past the heartbeat timeout is excluded from listActive and cannot be revived", () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080");

  now = 30001;
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.heartbeat(peerId), false);
});

test("deregister removes a peer immediately, and is idempotent-safe on unknown ids", () => {
  const registry = new PeerRegistry();
  const peerId = registry.register("http://192.168.1.50:8080");

  assert.equal(registry.deregister(peerId), true);
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.deregister(peerId), false);
  assert.equal(registry.deregister("never-existed"), false);
});

test("multiple peers are tracked independently", () => {
  const registry = new PeerRegistry();
  const a = registry.register("http://host-a:8080");
  const b = registry.register("http://host-b:8080");

  assert.notEqual(a, b);
  assert.equal(registry.listActive().length, 2);
});
```

Run:
```bash
cd coordinator && node --test tests/peer_registry.test.ts
```
Expected: **FAIL** — `src/peer_registry.ts` doesn't exist yet.

- [ ] **Step 2: Implement `PeerRegistry`**

Create `coordinator/src/peer_registry.ts`. Base it on `coordinator/src/registry.ts`'s current implementation (check that file for its exact current shape, post-Plan-3's own fix round which made `heartbeat` expiry-aware and moved the timeout to a constructor-level field rather than a per-call `listActive` parameter — mirror that same, already-corrected design, don't reintroduce the per-call-timeout version Plan 3 moved away from):
```ts
import { randomUUID } from "node:crypto";

export interface PeerInfo {
  peerId: string;
  endpoint: string;
}

interface StoredPeer extends PeerInfo {
  lastSeen: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

export class PeerRegistry {
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly peers = new Map<string, StoredPeer>();

  constructor(clock: () => number = Date.now, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  register(endpoint: string): string {
    const peerId = randomUUID();
    this.peers.set(peerId, { peerId, endpoint, lastSeen: this.clock() });
    return peerId;
  }

  heartbeat(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return false;
    }
    if (this.clock() - peer.lastSeen > this.timeoutMs) {
      this.peers.delete(peerId);
      return false;
    }
    peer.lastSeen = this.clock();
    return true;
  }

  deregister(peerId: string): boolean {
    return this.peers.delete(peerId);
  }

  listActive(): PeerInfo[] {
    const now = this.clock();
    const active: PeerInfo[] = [];
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen <= this.timeoutMs) {
        active.push({ peerId: peer.peerId, endpoint: peer.endpoint });
      } else {
        this.peers.delete(peerId);
      }
    }
    return active;
  }
}
```

If `coordinator/src/registry.ts`'s actual current field/method names or the expiry-handling approach differ from what's assumed above (verify against the real file before trusting this verbatim, since Plan 3's fix round changed this exact logic after the plan that introduced it was written), mirror the real, current file's approach — consistency with the sibling class matters more than matching this snippet exactly.

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && node --test tests/peer_registry.test.ts
```
Expected: **PASS** — all 6 tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/peer_registry.ts coordinator/tests/peer_registry.test.ts
git commit -m "Add PeerRegistry: federation peer registration and liveness tracking"
```

---

### Task 2: Federation-aware capacity endpoints

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/src/main.ts`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: `PeerRegistry` from Task 1, alongside the existing `NodeRegistry`/`ModelCatalog`.
- Produces: `createServer` gains a new required parameter for the peer registry; new endpoints:
  ```
  GET  /capacity              -> { activeNodes: number }
  POST /peers/register        -> { peerId: string }, body: { endpoint: string }
  GET  /peers                 -> PeerInfo[]
  DELETE /peers/:peerId       -> 204, or 404 if unknown
  GET  /catalog                -> now includes federated capacity from active peers
  ```
  No later plan yet depends on this directly, but it's the surface a future request-routing plan would build on.

- [ ] **Step 1: Write the failing tests**

Add to `coordinator/tests/server.test.ts`. Check the current file's `createServer(...)` call signature and update the test helper (`startTestServer` or equivalent) to pass a `PeerRegistry` instance alongside the existing arguments, matching whatever the actual current helper looks like:

```ts
import { PeerRegistry } from "../src/peer_registry.ts";

test("GET /capacity reports the active node count", async () => {
  const { server, baseUrl, registry } = await startTestServer();
  try {
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });

    const res = await fetch(`${baseUrl}/capacity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeNodes, 1);
  } finally {
    server.close();
  }
});

test("POST /peers/register returns a peerId, and GET /peers lists it", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://192.168.1.50:9090" }),
    });
    assert.equal(registerRes.status, 200);
    const { peerId } = await registerRes.json();
    assert.equal(typeof peerId, "string");

    const listRes = await fetch(`${baseUrl}/peers`);
    const peers = await listRes.json();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].endpoint, "http://192.168.1.50:9090");
  } finally {
    server.close();
  }
});

test("DELETE /peers/:peerId deregisters a peer, 204 for known, 404 for unknown", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://192.168.1.50:9090" }),
    });
    const { peerId } = await registerRes.json();

    const deleteRes = await fetch(`${baseUrl}/peers/${peerId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 204);

    const listRes = await fetch(`${baseUrl}/peers`);
    assert.equal((await listRes.json()).length, 0);

    const deleteAgain = await fetch(`${baseUrl}/peers/${peerId}`, { method: "DELETE" });
    assert.equal(deleteAgain.status, 404);
  } finally {
    server.close();
  }
});

test("GET /catalog aggregates a live peer's reported capacity with local capacity", async () => {
  // Two real, independent coordinator instances. Instance B has enough
  // local nodes to unlock a model on its own; instance A has none, but
  // federates with B, so A's catalog should reflect the combined count.
  const catalogEntries = [
    { id: "small", displayName: "Small", minActiveNodes: 1 },
  ];

  const { server: serverB, baseUrl: baseUrlB } = await startTestServer(catalogEntries);
  await fetch(`${baseUrlB}/nodes/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
  });

  const { server: serverA, baseUrl: baseUrlA } = await startTestServer(catalogEntries);

  try {
    // A has zero local nodes -- confirm the model is NOT available yet.
    const beforeRes = await fetch(`${baseUrlA}/catalog`);
    const before = await beforeRes.json();
    assert.equal(before.find((e: any) => e.id === "small").available, false);

    // A federates with B.
    await fetch(`${baseUrlA}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: baseUrlB }),
    });

    // Now A's catalog should reflect B's capacity too.
    const afterRes = await fetch(`${baseUrlA}/catalog`);
    const after = await afterRes.json();
    assert.equal(after.find((e: any) => e.id === "small").available, true);
  } finally {
    serverA.close();
    serverB.close();
  }
});

test("GET /catalog degrades gracefully when a registered peer is unreachable", async () => {
  const catalogEntries = [
    { id: "small", displayName: "Small", minActiveNodes: 1 },
  ];
  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    // Register a peer endpoint that nothing is listening on.
    await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:1" }),
    });

    const res = await fetch(`${baseUrl}/catalog`);
    assert.equal(res.status, 200);
    const catalog = await res.json();
    // Should not throw, hang, or 500 -- the unreachable peer just
    // contributes 0.
    assert.equal(catalog.find((e: any) => e.id === "small").available, false);
  } finally {
    server.close();
  }
});
```

Update `startTestServer` (the existing helper in this file) to accept an optional `catalogEntries` parameter (defaulting to whatever it currently uses) and to construct + pass a `PeerRegistry` to `createServer`, returning it alongside `server`/`baseUrl`/`registry` if the tests above need it. Match the file's existing helper style rather than introducing a new one.

Run:
```bash
cd coordinator && node --test tests/server.test.ts
```
Expected: **FAIL** — `createServer` doesn't accept a `PeerRegistry` yet, and the new endpoints don't exist.

- [ ] **Step 2: Implement the new endpoints**

Modify `coordinator/src/server.ts`. Add the `PeerRegistry` import and parameter to `createServer`:
```ts
import { PeerRegistry } from "./peer_registry.ts";

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry) {
```

Add capacity-fetching helper (with a timeout, per Global Constraints):
```ts
async function fetchPeerCapacity(endpoint: string): Promise<number> {
  try {
    const res = await fetch(`${endpoint}/capacity`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      return 0;
    }
    const body = await res.json();
    return typeof body.activeNodes === "number" ? body.activeNodes : 0;
  } catch {
    return 0;
  }
}

async function federatedActiveNodeCount(registry: NodeRegistry, peers: PeerRegistry): Promise<number> {
  const local = registry.listActive().length;
  const peerCounts = await Promise.all(
    peers.listActive().map(peer => fetchPeerCapacity(peer.endpoint)));
  return local + peerCounts.reduce((sum, n) => sum + n, 0);
}
```

Add the new routes inside the request handler (check the existing routing structure in this file — a chain of `if (method === ... && parts[0] === ...)` blocks — and add these following the same pattern):
```ts
if (method === "GET" && parts[0] === "capacity" && parts.length === 1) {
  sendJson(res, 200, { activeNodes: registry.listActive().length });
  return;
}

if (method === "POST" && parts[0] === "peers" && parts.length === 2 && parts[1] === "register") {
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) {
    sendJson(res, 400, { error: "endpoint must be a non-empty string" });
    return;
  }
  const peerId = peers.register(candidate.endpoint);
  sendJson(res, 200, { peerId });
  return;
}

if (method === "GET" && parts[0] === "peers" && parts.length === 1) {
  sendJson(res, 200, peers.listActive());
  return;
}

if (method === "DELETE" && parts[0] === "peers" && parts.length === 2) {
  const ok = peers.deregister(parts[1]);
  if (!ok) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(204);
  res.end();
  return;
}

if (method === "GET" && parts[0] === "catalog" && parts.length === 1) {
  const activeNodeCount = await federatedActiveNodeCount(registry, peers);
  sendJson(res, 200, catalog.availability(activeNodeCount));
  return;
}
```

The existing `GET /catalog` block (currently synchronous, using `registry.listActive().length` directly) needs to be replaced by the async version above rather than duplicated — check the current file for its exact current position/form before editing, and make sure the surrounding request handler is already `async` (it should be, from Plan 3, since `POST /nodes/register` already awaits `readJsonBody`).

Reuse the existing malformed-JSON try/catch wrapper (from Plan 3's fix round) around this whole routing block — don't introduce a second one; verify the new routes are inside whatever scope that wrapper already covers.

- [ ] **Step 3: Update `main.ts`**

Modify `coordinator/src/main.ts` to construct a `PeerRegistry` and pass it to `createServer`:
```ts
import { PeerRegistry } from "./peer_registry.ts";
// ...
const peers = new PeerRegistry();
const server = createServer(registry, catalog, peers);
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — the full suite, including all 5 new tests. The federation test spins up two real server instances on two real ephemeral ports and makes real HTTP calls between them — this is a genuine integration test, not a mock.

- [ ] **Step 5: Commit**

```bash
git add coordinator/src/server.ts coordinator/src/main.ts coordinator/tests/server.test.ts
git commit -m "Add federation-aware capacity aggregation: /capacity, /peers, federated /catalog"
```

---

## What this plan does not do

Does not implement cross-instance request routing (see the deliberate scope boundary above — this plan aggregates capacity numbers, it doesn't hand off actual inference requests to a peer's nodes). Does not add authentication to `/peers/*` or `/capacity` (matches Plan 3's existing no-auth, LAN-trusted scope; a malicious peer can currently misreport its capacity, which is a real, named, unaddressed gap for any future production use). Does not implement the spec's "defederation from bad-actor instances" as an automated policy — `DELETE /peers/:peerId` gives an operator the manual mechanism, deciding when to use it is out of scope. Does not persist peer registrations across restarts (in-memory only, matching `NodeRegistry`).
