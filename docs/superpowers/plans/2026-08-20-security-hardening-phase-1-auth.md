# Security Hardening Phase 1: Shared-Secret Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a shared secret (`SWARM_AUTH_TOKEN`) on every coordinator endpoint and every `swarm-node-agent` endpoint, closing "anyone can register a fake node, submit inference requests, or read swarm state" — with no new dependencies anywhere.

**Architecture:** One token, same value everywhere, checked via `Authorization: Bearer <token>` with a constant-time comparison. Coordinator and node-agent each fail fast at startup if the token isn't set. The static dashboard shell and OpenAPI doc stay unauthenticated (nothing to protect, and you need to load them before you have anywhere to enter a token); every live endpoint requires it. `swarm-rpc-server` gets no code changes — its exposure is covered by a README tunnel recommendation instead, since llama.cpp's RPC backend has no auth hook to build on.

**Tech Stack:** Coordinator: Node.js native TypeScript, `node:crypto`'s `timingSafeEqual`, `node:test`. Node agent: C++17, hand-rolled constant-time comparison, GoogleTest via ctest.

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State this in every dispatch — it does not carry over automatically.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, native `fetch`, `AbortSignal.timeout`, etc.
- Core (C++): raw llama.cpp C API only, never `vendor/llama.cpp/common/`. No new external dependency for this plan — the constant-time comparison is hand-rolled.
- Follow this repo's existing routing pattern in `server.ts` (manual `parts` splitting, no router library) and existing error-response conventions (`sendJson` helper, matching status codes).
- This plan runs in its own git worktree at `.worktrees/security-phase-1-auth` (branch `security-phase-1-auth`), created via the `using-git-worktrees` skill before Task 1 starts, off `master`. Because a new worktree checks out a fresh copy from git's last-committed state, an unrelated uncommitted change that may exist in the main `DDC` working copy's `coordinator/tests/server.test.ts` (pre-dating this plan, unrelated to this work) will **not** be present in this worktree — nothing to preserve or reconcile, it's simply not there.
- Run coordinator tests: `cd coordinator && npm test`. Run coordinator e2e test: `cd coordinator && npm run test:e2e` (requires a built `swarm-node-agent` and the TinyLlama test model — skips itself with a clear message if either is missing).
- Build core: `cmake -G Ninja -S . -B build && cmake --build build` (ccache at `CCACHE_DIR=/c/Users/User/.ccache` — reuse it in the new worktree rather than cold-building). Run core tests: `cd build && ctest`, or run a specific test binary directly, e.g. `./build/core/tests/http_server_test.exe`.

---

### Task 1: Coordinator — require auth on every route in `server.ts`

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `createServer(registry, catalog, peers, classifier, reputation, authToken: string)` — **signature changes from 5 params to 6**, `authToken` required, last position. Every later task that calls `createServer` (Task 2's `main.ts`, Task 3's `client.test.ts`/`generate_e2e.ts`) must pass this 6th argument. A request without a valid `Authorization: Bearer <authToken>` header gets `401 { "error": "missing or invalid Authorization header" }` via the existing `sendJson` helper, for every route except `GET /`, `GET /app.js`, `GET /style.css`, and `GET /openapi.json`.

- [ ] **Step 1: Write the new auth-specific tests (failing)**

Open `coordinator/tests/server.test.ts`. Add this constant right after the existing `DEFAULT_TEST_CATALOG` definition (around line 16):

```typescript
const TEST_AUTH_TOKEN = "test-secret-token-1234";
```

Replace the existing `startTestServer` function with this version (adds the `authToken` parameter, defaulted so every existing no-arg call site `startTestServer()` keeps working unchanged; returns `authToken` too so new tests can reference it):

```typescript
async function startTestServer(
  catalogEntries: CatalogEntry[] = DEFAULT_TEST_CATALOG,
  peers: PeerRegistry = new PeerRegistry(),
  classifier: SafetyClassifier = new KeywordSafetyClassifier([]),
  reputation: ReputationTracker = new ReputationTracker(),
  authToken: string = TEST_AUTH_TOKEN,
) {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog(catalogEntries);
  const server = createServer(registry, catalog, peers, classifier, reputation, authToken);

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a real port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, registry, peers, authToken };
}

// Every existing test in this file that calls bare `fetch(...)` is being
// migrated to call `authFetch(...)` instead (same signature, one line
// each) -- this helper is what actually attaches the token, so tests read
// almost identically to before but keep working once the server enforces
// auth on every route.
function authFetch(url: string, options: RequestInit = {}, token: string = TEST_AUTH_TOKEN): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
  });
}
```

Now add these new tests directly after `startTestServer`/`authFetch` (before the first existing `test(...)` block):

```typescript
test("a mutating route rejects a request with no Authorization header with 401", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    assert.equal(res.status, 401);
    // No side effect: the node must not have been registered.
    const nodesRes = await authFetch(`${baseUrl}/nodes`);
    const nodes = await nodesRes.json();
    assert.equal(nodes.length, 0);
  } finally {
    server.close();
  }
});

test("a mutating route rejects a request with the wrong token with 401", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(
      `${baseUrl}/nodes/register`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }) },
      "wrong-token",
    );
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("a read route rejects a request with no Authorization header with 401", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("a read route succeeds with a valid Authorization header", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("the static dashboard routes stay unauthenticated", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const indexRes = await fetch(baseUrl);
    assert.equal(indexRes.status, 200);
    const appJsRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(appJsRes.status, 200);
    const styleCssRes = await fetch(`${baseUrl}/style.css`);
    assert.equal(styleCssRes.status, 200);
    const openApiRes = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(openApiRes.status, 200);
  } finally {
    server.close();
  }
});

test("POST /generate forwards the shared auth token to the node agent", async () => {
  let receivedAuth: string | null = null;
  const stubAgent = createHttpServer((req, res) => {
    receivedAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "hello" }));
  });
  await new Promise<void>(resolve => stubAgent.listen(0, "127.0.0.1", resolve));
  const stubAddress = stubAgent.address();
  if (stubAddress === null || typeof stubAddress === "string") {
    throw new Error("expected stub agent to bind a real port");
  }
  const stubEndpoint = `http://127.0.0.1:${stubAddress.port}`;

  // registry is built directly here (not via startTestServer, which owns
  // its own internal registry with no way to pre-register a node into it
  // before the server starts) so the stub agent above can be registered
  // into it before createServer is called.
  const registry = new NodeRegistry();
  registry.register(stubEndpoint, "desktop", undefined, "tinyllama-1.1b");
  const catalog = new ModelCatalog(DEFAULT_TEST_CATALOG);
  const server = createServer(registry, catalog, new PeerRegistry(), new KeywordSafetyClassifier([]), new ReputationTracker(), TEST_AUTH_TOKEN);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a real port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });
    assert.equal(res.status, 200);
    assert.equal(receivedAuth, `Bearer ${TEST_AUTH_TOKEN}`);
  } finally {
    server.close();
    stubAgent.close();
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd coordinator && npm test`
Expected: the new tests FAIL (either a TypeScript error because `createServer` doesn't yet accept 6 arguments, or the auth-check tests get `200`/no-401 since `server.ts` doesn't check anything yet). The hundreds of *existing* tests in this file still pass at this point (server.ts is unchanged so far).

- [ ] **Step 3: Implement the auth check in `server.ts`**

Add this import at the top of `coordinator/src/server.ts` (alongside the existing imports):

```typescript
import { timingSafeEqual } from "node:crypto";
```

Add this helper function right after the existing `sendJson` function (around line 55):

```typescript
function isAuthorized(req: IncomingMessage, authToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(authToken);
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false -- checking length first is fine (it doesn't leak anything
  // about the token's *content*, only its fixed, publicly-known length),
  // it's the byte-by-byte comparison that must be constant-time.
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
```

Change the `createServer` export signature (around line 96) from:

```typescript
export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker) {
```

to:

```typescript
export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker, authToken: string) {
```

Inside the handler, right after `const parts = url.pathname.split("/").filter(Boolean);` (around line 101), add the auth gate before any route branch:

```typescript
      // These four are the only routes reachable with no token: the static
      // dashboard shell (you need to load the page before you have
      // anywhere to paste a token into) and the OpenAPI document (a fixed
      // API schema, not live swarm data -- a developer needs to be able to
      // read it to find out a token is even required).
      const isPublicRoute =
        (method === "GET" && parts.length === 0) ||
        (method === "GET" && parts.length === 1 &&
          (parts[0] === "app.js" || parts[0] === "style.css" || parts[0] === "openapi.json"));

      if (!isPublicRoute && !isAuthorized(req, authToken)) {
        sendJson(res, 401, { error: "missing or invalid Authorization header" });
        return;
      }
```

In the `POST /generate` handler, update the outbound `fetch` call to the node agent (around line 396) to also send the token — the coordinator is a client of the node agent here, and Task 6 will make the node agent require it:

```typescript
        try {
          const nodeRes = await fetch(`${node.endpoint}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict }),
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          });
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd coordinator && npm test`
Expected: the 6 new tests from Step 1 PASS. Hundreds of *existing* tests now FAIL with 401s — expected at this point, fixed in the next step.

- [ ] **Step 5: Migrate every existing test in the file to use `authFetch`**

This is a mechanical, bounded rename: in `coordinator/tests/server.test.ts`, every call of the form `await fetch(...)` *inside a `test(...)` block* (not inside `startTestServer`, `authFetch` itself, or the new tests just added in Step 1, which already use `authFetch`) becomes `await authFetch(...)` — same arguments, just the function name changes. There are roughly 100 such call sites across the file's ~1267 lines (this count includes the file before this task's Step 1 additions).

Do the rename, then verify completeness with:

Run: `grep -n "await fetch(" coordinator/tests/server.test.ts`
Expected: **zero matches**. Any match found is a missed call site — rename it and re-run this grep until it returns nothing.

- [ ] **Step 6: Run the full test suite to verify everything passes**

Run: `cd coordinator && npm test`
Expected: PASS, all tests (the ~100+ pre-existing tests plus the 6 new ones from Step 1) green.

- [ ] **Step 7: Commit**

```bash
git add coordinator/src/server.ts coordinator/tests/server.test.ts
git commit -m "Require SWARM_AUTH_TOKEN on every coordinator route except the static dashboard shell and OpenAPI doc"
```

---

### Task 2: Coordinator — read `SWARM_AUTH_TOKEN` and fail fast in `main.ts`

**Files:**
- Modify: `coordinator/src/main.ts`
- Modify: `coordinator/tests/main.test.ts`

**Interfaces:**
- Consumes: `createServer(registry, catalog, peers, classifier, reputation, authToken)` from Task 1 (6-arg signature).
- Produces: `main.ts` exits with code `1` and a stderr message if `SWARM_AUTH_TOKEN` is unset; otherwise its startup log line becomes `coordinator listening on ${host}:${port} (authentication required -- see SWARM_AUTH_TOKEN)` (was previously `... (no authentication -- trusted networks only)`). Task 7's README updates must match this exact new log text if they quote it.

- [ ] **Step 1: Write the failing tests**

Open `coordinator/tests/main.test.ts`. Update all three existing tests' `env` objects to include `SWARM_AUTH_TOKEN`, and update the expected regex to match the new log message. Replace the whole file's three existing `test(...)` blocks with:

```typescript
test("main.ts binds to 127.0.0.1 by default and discloses that authentication is required in its startup log", async () => {
  const env = { ...process.env, PORT: "0", SWARM_AUTH_TOKEN: "test-secret-token-1234" };
  delete env.HOST;

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(authentication required -- see SWARM_AUTH_TOKEN\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts binds to the host given via the HOST env var", async () => {
  const env = { ...process.env, PORT: "0", HOST: "0.0.0.0", SWARM_AUTH_TOKEN: "test-secret-token-1234" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 0\.0\.0\.0:0 \(authentication required -- see SWARM_AUTH_TOKEN\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts falls back to 127.0.0.1 when HOST is set but empty, not all interfaces", async () => {
  const env = { ...process.env, PORT: "0", HOST: "", SWARM_AUTH_TOKEN: "test-secret-token-1234" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(authentication required -- see SWARM_AUTH_TOKEN\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts refuses to start when SWARM_AUTH_TOKEN is unset", async () => {
  const env = { ...process.env, PORT: "0" };
  delete env.SWARM_AUTH_TOKEN;

  const child = spawn(process.execPath, [mainPath], { env });
  const exitCode = await new Promise<number | null>(resolve => {
    child.on("exit", code => resolve(code));
  });
  assert.notEqual(exitCode, 0);
});

test("main.ts refuses to start when SWARM_AUTH_TOKEN is set but empty", async () => {
  const env = { ...process.env, PORT: "0", SWARM_AUTH_TOKEN: "" };

  const child = spawn(process.execPath, [mainPath], { env });
  const exitCode = await new Promise<number | null>(resolve => {
    child.on("exit", code => resolve(code));
  });
  assert.notEqual(exitCode, 0);
});
```

(Leave the file's existing imports, `mainPath` constant, and `waitForStartupLog` helper untouched — only the `test(...)` blocks change.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd coordinator && npm test -- --test-name-pattern="main.ts"`
Expected: FAIL — the first three tests time out waiting for a startup log (since `main.ts` doesn't read `SWARM_AUTH_TOKEN` yet and `createServer` now requires a 6th argument it isn't passing, so this will actually throw a TypeScript/runtime error on the `createServer(...)` call); the two new "refuses to start" tests fail because the process currently *does* start successfully regardless.

- [ ] **Step 3: Implement in `main.ts`**

Replace the full contents of `coordinator/src/main.ts` with:

```typescript
import { createServer } from "./server.ts";
import { NodeRegistry } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";
import { KeywordSafetyClassifier } from "./safety_classifier.ts";
import { ReputationTracker } from "./reputation_tracker.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST || "127.0.0.1";
const authToken = process.env.SWARM_AUTH_TOKEN;
if (!authToken) {
  console.error("SWARM_AUTH_TOKEN environment variable must be set -- refusing to start unauthenticated");
  process.exit(1);
}
const registry = new NodeRegistry();
const catalog = new ModelCatalog();
const peers = new PeerRegistry();
const classifier = new KeywordSafetyClassifier([]);
const reputation = new ReputationTracker();
const server = createServer(registry, catalog, peers, classifier, reputation, authToken);

server.listen(port, host, () => {
  console.log(`coordinator listening on ${host}:${port} (authentication required -- see SWARM_AUTH_TOKEN)`);
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd coordinator && npm test -- --test-name-pattern="main.ts"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `cd coordinator && npm test`
Expected: PASS (everything from Task 1 plus these 5).

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/main.ts coordinator/tests/main.test.ts
git commit -m "Read SWARM_AUTH_TOKEN in main.ts and refuse to start unauthenticated"
```

---

### Task 3: Coordinator — `SwarmClient` sends the token; fix `client.test.ts` and `generate_e2e.ts`

**Files:**
- Modify: `coordinator/src/client.ts`
- Modify: `coordinator/tests/client.test.ts`
- Modify: `coordinator/tests/generate_e2e.ts`

**Interfaces:**
- Consumes: `createServer(..., authToken)` from Task 1.
- Produces: `SwarmClient`'s constructor signature **changes from `constructor(baseUrl: string)` to `constructor(baseUrl: string, authToken: string)`** — both required, `authToken` second. Every method attaches `Authorization: Bearer <authToken>` to its request. This is a breaking change to every existing `new SwarmClient(...)` call site (10 in `client.test.ts`, 1 in `generate_e2e.ts`) — all must gain a second argument.

- [ ] **Step 1: Write the failing test**

Add this test to `coordinator/tests/client.test.ts` (after the existing `startStubNodeAgent` helper, before the first `test(...)` block):

```typescript
test("SwarmClient sends the configured auth token on every request", async () => {
  let receivedAuth: string | null = null;
  const stub = createHttpServer((req, res) => {
    receivedAuth = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([]));
  });
  await new Promise<void>(resolve => stub.listen(0, resolve));
  const address = stub.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub server to bind a port");
  }
  try {
    const client = new SwarmClient(`http://127.0.0.1:${address.port}`, "a-specific-test-token");
    await client.listNodes();
    assert.equal(receivedAuth, "Bearer a-specific-test-token");
  } finally {
    stub.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd coordinator && npm test -- --test-name-pattern="SwarmClient sends the configured"`
Expected: FAIL (compile error: `SwarmClient` constructor doesn't accept a second argument yet).

- [ ] **Step 3: Implement in `client.ts`**

Replace the full contents of `coordinator/src/client.ts` with:

```typescript
export class SwarmClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authToken = authToken;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, authorization: `Bearer ${this.authToken}` };
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal,
    });
  }

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

  async generate(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): Promise<{ text: string }> {
    const res = await this.postJson("/generate", { prompt, modelId, n_predict }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`generate failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async heartbeat(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST", headers: this.authHeaders(), signal });
    return res.status === 204;
  }

  async recordAgreement(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST", headers: this.authHeaders(), signal });
    return res.status === 204;
  }

  async recordDisagreement(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST", headers: this.authHeaders(), signal });
    return res.status === 204;
  }

  async getReputation(nodeId: string, signal?: AbortSignal): Promise<{ agreements: number; disagreements: number; trusted: boolean } | null> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation`, { headers: this.authHeaders(), signal });
    if (res.status === 404) {
      return null;
    }
    return res.json();
  }

  async listNodes(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/nodes`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNodes failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async listNodesByLocality(signal?: AbortSignal): Promise<Record<string, unknown[]>> {
    const res = await fetch(`${this.baseUrl}/nodes/locality`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNodesByLocality failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async getCapacity(signal?: AbortSignal): Promise<number> {
    const res = await fetch(`${this.baseUrl}/capacity`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`getCapacity failed: ${res.status} ${detail}`);
    }
    const body = await res.json();
    return body.activeNodes;
  }

  async registerPeer(endpoint: string, signal?: AbortSignal): Promise<string> {
    const res = await this.postJson("/peers/register", { endpoint }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`registerPeer failed: ${res.status} ${detail}`);
    }
    const body = await res.json();
    return body.peerId;
  }

  async peerHeartbeat(peerId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}/heartbeat`, { method: "POST", headers: this.authHeaders(), signal });
    return res.status === 204;
  }

  async listPeers(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/peers`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listPeers failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async deregisterPeer(peerId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}`, { method: "DELETE", headers: this.authHeaders(), signal });
    return res.status === 204;
  }

  async getCatalog(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/catalog`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`getCatalog failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async classify(prompt: string, signal?: AbortSignal): Promise<{ safe: boolean; categories: string[] }> {
    const res = await this.postJson("/classify", { prompt }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`classify failed: ${res.status} ${detail}`);
    }
    return res.json();
  }
}
```

- [ ] **Step 4: Fix every other existing test in `client.test.ts`**

`client.test.ts` has its own separate `startTestServer()` helper (not the one in `server.test.ts`) and 10 total `new SwarmClient(...)` call sites. Two mechanical fixes:

1. In `client.test.ts`'s `startTestServer()` function, add a `TEST_AUTH_TOKEN` constant near the top of the file (alongside the existing imports) and thread it through:

```typescript
const TEST_AUTH_TOKEN = "test-secret-token-1234";
```

Change:
```typescript
  const server = createServer(registry, catalog, peers, classifier, reputation);
```
to:
```typescript
  const server = createServer(registry, catalog, peers, classifier, reputation, TEST_AUTH_TOKEN);
```

2. Every `new SwarmClient(baseUrl)` call site in this file (there are 10, one per test) becomes `new SwarmClient(baseUrl, TEST_AUTH_TOKEN)`. Verify completeness with:

Run: `grep -n "new SwarmClient(baseUrl)" coordinator/tests/client.test.ts`
Expected: **zero matches** after the fix (every call site now has the second argument).

- [ ] **Step 5: Fix `generate_e2e.ts`**

Three changes to `coordinator/tests/generate_e2e.ts`:

1. Add the token to the spawned node-agent's environment (around line 52-54):

```typescript
    const spawnEnv = process.platform === "win32"
      ? { ...process.env, PATH: `C:\\msys64\\ucrt64\\bin;${process.env.PATH ?? ""}`, SWARM_AUTH_TOKEN: "test-secret-token-1234" }
      : { ...process.env, SWARM_AUTH_TOKEN: "test-secret-token-1234" };
```

2. Add the token header to `waitForHealth`'s poll request (around line 29):

```typescript
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
```

3. Pass the token to `createServer` and `SwarmClient` (around lines 64 and 73):

```typescript
      const server = createServer(registry, catalog, peers, classifier, reputation, "test-secret-token-1234");
```
```typescript
        const client = new SwarmClient(baseUrl, "test-secret-token-1234");
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd coordinator && npm test`
Expected: PASS, all tests including the new one from Step 1.

`npm run test:e2e` requires a built `swarm-node-agent` and downloaded test model, which may not be available yet at this point in the plan (Task 6 doesn't build anything, and the model download is a separate manual step per the README) — run it if available; if it self-skips with its documented skip message, that's expected and not a failure of this task.

- [ ] **Step 7: Commit**

```bash
git add coordinator/src/client.ts coordinator/tests/client.test.ts coordinator/tests/generate_e2e.ts
git commit -m "SwarmClient sends the shared auth token on every request"
```

---

### Task 4: Dashboard — token-entry UI in the browser client

**Files:**
- Modify: `coordinator/public/index.html`
- Modify: `coordinator/public/app.js`

**Interfaces:**
- Consumes: the coordinator's auth requirement from Task 1 (the dashboard's live `fetch` calls will 401 without a token).
- Produces: nothing consumed by later tasks. No automated test exists for this project's dashboard JS (plain DOM-manipulating script, no test framework wired up for it, and this plan adds no new dependency to create one) — verified manually in the browser instead, per this step's instructions below.

- [ ] **Step 1: Add the token-entry UI to `index.html`**

In `coordinator/public/index.html`, add a new `<section>` immediately after `<header>...</header>` and before `<main>` (i.e., right after line 13's `</header>`):

```html
  <section id="auth">
    <h2>Coordinator access token</h2>
    <p class="notice">
      Every live endpoint on this coordinator requires <code>SWARM_AUTH_TOKEN</code>.
      Paste it below to use this dashboard. Stored only for this browser tab —
      cleared when the tab closes.
    </p>
    <input id="token-input" type="password" placeholder="Paste SWARM_AUTH_TOKEN...">
    <button id="save-token-button" type="button">Save token</button>
    <p id="token-status" role="status"></p>
  </section>
```

- [ ] **Step 2: Update `app.js` to store and send the token**

Replace the full contents of `coordinator/public/app.js` with:

```javascript
const TOKEN_KEY = "swarmAuthToken";

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

function authedFetch(url, options = {}) {
  const token = getToken();
  return fetch(url, {
    ...options,
    headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

async function refreshStatus() {
  const activeCountEl = document.getElementById("active-count");
  const tbody = document.querySelector("#catalog-table tbody");
  try {
    const [capacityRes, catalogRes] = await Promise.all([
      authedFetch("/capacity"),
      authedFetch("/catalog"),
    ]);
    if (capacityRes.status === 401 || catalogRes.status === 401) {
      activeCountEl.textContent = "token required";
      document.getElementById("token-status").textContent =
        "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.";
      return;
    }
    const capacity = await capacityRes.json();
    const catalog = await catalogRes.json();

    activeCountEl.textContent = String(capacity.activeNodes);

    tbody.innerHTML = "";
    for (const entry of catalog) {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = entry.displayName;

      const minCell = document.createElement("td");
      minCell.textContent = String(entry.minActiveNodes);

      const availCell = document.createElement("td");
      availCell.textContent = entry.available ? "yes" : "no";

      row.append(nameCell, minCell, availCell);
      tbody.appendChild(row);
    }
  } catch (err) {
    activeCountEl.textContent = "unavailable";
    console.error("failed to refresh swarm status", err);
  }
}

async function classifyPrompt() {
  const input = document.getElementById("prompt-input");
  const resultEl = document.getElementById("classify-result");
  const prompt = input.value;

  resultEl.textContent = "Checking...";
  try {
    const res = await authedFetch("/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (res.status === 401) {
      resultEl.textContent = "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.";
      return;
    }
    const body = await res.json();
    resultEl.textContent = body.safe
      ? "safe: true"
      : `safe: false (categories: ${body.categories.length > 0 ? body.categories.join(", ") : "none"})`;
  } catch (err) {
    resultEl.textContent = "Error checking prompt.";
    console.error("classify request failed", err);
  }
}

document.getElementById("classify-button").addEventListener("click", classifyPrompt);

document.getElementById("save-token-button").addEventListener("click", () => {
  const input = document.getElementById("token-input");
  setToken(input.value);
  document.getElementById("token-status").textContent = "Token saved for this tab.";
  refreshStatus();
});

document.getElementById("token-input").value = getToken();

refreshStatus();
setInterval(refreshStatus, 5000);
```

- [ ] **Step 3: Manual verification**

Run (from repo root, in the worktree): `SWARM_AUTH_TOKEN=manual-test-token PORT=8080 node coordinator/src/main.ts`

Then in a browser:
1. Open `http://127.0.0.1:8080/` — page loads (static shell, no token needed yet). "Active nodes" shows "token required".
2. Paste `manual-test-token` into the token field, click "Save token" — status area updates, "Active nodes" populates with a real number (0, with no nodes registered).
3. Type a prompt, click "Check safety" — result shows `safe: true` (matches existing zero-rule-classifier behavior).
4. Clear the token field, save an empty/wrong token, click "Check safety" again — result shows the "Invalid or missing token" message, not a raw error or a false "safe: true".

Stop the server with `Ctrl+C` when done.

- [ ] **Step 4: Commit**

```bash
git add coordinator/public/index.html coordinator/public/app.js
git commit -m "Add token-entry UI to the dashboard so it works against an authenticated coordinator"
```

---

### Task 5: Node agent prerequisite — capture HTTP headers in `HttpServer`

**Files:**
- Modify: `core/include/swarm/http_server.h`
- Modify: `core/src/http_server.cpp`
- Test: `core/tests/http_server_test.cpp`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HttpRequest` gains a `std::map<std::string, std::string> headers` field (header names lowercased during parsing — look up with a lowercase key). Task 6's `node_agent_main.cpp` depends on this field existing to read `headers.find("authorization")`.

- [ ] **Step 1: Write the failing test**

Add this test to `core/tests/http_server_test.cpp`, after the last existing `TEST_F` (`ReturnsA400ForHeadersExceedingTheSizeCap`) and before the closing `}  // namespace`:

```cpp
TEST_F(HttpServerFixture, ParsesRequestHeadersIntoTheHandler) {
    swarm::HttpServer server(kTestPort + 7);
    std::string capturedAuth;
    bool foundHeader = false;
    server.route("GET", "/health", [&capturedAuth, &foundHeader](const swarm::HttpRequest& req) {
        auto it = req.headers.find("authorization");
        foundHeader = it != req.headers.end();
        if (foundHeader) {
            capturedAuth = it->second;
        }
        return swarm::HttpResponse{200, "{}"};
    });
    startServer(server);

    sendRawRequest(kTestPort + 7, "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc123\r\n\r\n");

    EXPECT_TRUE(foundHeader);
    EXPECT_EQ(capturedAuth, "Bearer abc123");
}
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `cmake --build build`
Run: `./build/core/tests/http_server_test.exe --gtest_filter=HttpServerFixture.ParsesRequestHeadersIntoTheHandler`
Expected: build FAILS (`HttpRequest` has no member `headers` yet).

- [ ] **Step 3: Implement in `http_server.h`**

Replace the `HttpRequest` struct and add the `<map>` include in `core/include/swarm/http_server.h`:

```cpp
#pragma once

#include <functional>
#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace swarm {

struct HttpRequest {
    std::string method;
    std::string path;
    std::string body;
    // Header names are lowercased during parsing -- look up with a
    // lowercase key (e.g. headers.find("authorization"), not "Authorization").
    std::map<std::string, std::string> headers;
};
```

(The rest of the file — `HttpResponse`, `HttpHandler`, `HttpServer` — is unchanged.)

- [ ] **Step 4: Implement in `http_server.cpp`**

Add `#include <map>` alongside the existing includes at the top of `core/src/http_server.cpp` (after `#include <cstdint>`):

```cpp
#include <cstdint>
#include <map>
#include <sstream>
```

Add a `headers` field to the `ParsedHead` struct (around line 85):

```cpp
struct ParsedHead {
    std::string method;
    std::string path;
    size_t contentLength = 0;
    std::map<std::string, std::string> headers;
};
```

Replace the header-parsing loop inside `parseHead` (the `while (std::getline(stream, headerLine))` block) with this version, which captures every header into `result.headers` while preserving the existing `content-length` special-case parsing exactly (same rejection behavior for a negative or oversized value):

```cpp
    std::string headerLine;
    while (std::getline(stream, headerLine)) {
        if (!headerLine.empty() && headerLine.back() == '\r') {
            headerLine.pop_back();
        }
        size_t colon = headerLine.find(':');
        if (colon == std::string::npos) {
            continue;
        }
        std::string name = headerLine.substr(0, colon);
        for (char& c : name) {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
        std::string value = headerLine.substr(colon + 1);
        size_t firstNonSpace = value.find_first_not_of(" \t");
        value = (firstNonSpace == std::string::npos) ? std::string() : value.substr(firstNonSpace);
        result.headers[name] = value;

        if (name == "content-length") {
            if (value.empty()) {
                continue;
            }
            if (value[0] == '-') {
                // std::stoul accepts a leading '-' and silently wraps it
                // into a huge unsigned value (per strtoul's documented
                // behavior) instead of throwing -- reject explicitly so
                // "Content-Length: -5" is treated as malformed rather
                // than as a request to read billions of bytes of body.
                throw std::runtime_error("invalid Content-Length");
            }
            unsigned long parsed = std::stoul(value);
            if (parsed > kMaxRequestBodyBytes) {
                throw std::runtime_error(
                    "Content-Length exceeds maximum allowed request body size");
            }
            result.contentLength = static_cast<size_t>(parsed);
        }
    }
    return result;
}
```

Update the `HttpRequest` construction inside `run()` (around line 256) to pass the headers through:

```cpp
            HttpRequest request{parsed.method, parsed.path, body, parsed.headers};
```

Add a `401` case to `writeResponse`'s status-text mapping (Task 6 will start returning 401s, and this server should format the status line correctly for it):

```cpp
    const char* statusText = response.status == 200 ? "OK"
                              : response.status == 404 ? "Not Found"
                              : response.status == 400 ? "Bad Request"
                              : response.status == 401 ? "Unauthorized"
                                                        : "Error";
```

- [ ] **Step 5: Build and run to verify it passes**

Run: `cmake --build build`
Run: `./build/core/tests/http_server_test.exe`
Expected: PASS, all 8 tests (7 existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add core/include/swarm/http_server.h core/src/http_server.cpp core/tests/http_server_test.cpp
git commit -m "Capture request headers in HttpServer, needed for auth checks"
```

---

### Task 6: Node agent — require `SWARM_AUTH_TOKEN` on `/health` and `/complete`

**Files:**
- Modify: `core/src/node_agent_main.cpp`
- Test: `core/tests/node_agent_test.cpp`

**Interfaces:**
- Consumes: `HttpRequest.headers` from Task 5.
- Produces: `swarm-node-agent` exits with code `1` and a stderr message if `SWARM_AUTH_TOKEN` is unset at startup. Both `GET /health` and `POST /complete` return `401 {"error":"missing or invalid Authorization header"}` for a missing or wrong token, checked before any other handler logic.

- [ ] **Step 1: Write the failing tests**

Open `core/tests/node_agent_test.cpp`. Add this constant and helper right after the existing `testModelPath()` function (around line 28), inside the anonymous namespace:

```cpp
constexpr const char* kTestAuthToken = "test-secret-token-1234";

void setTestAuthTokenEnv() {
#ifdef _WIN32
    _putenv_s("SWARM_AUTH_TOKEN", kTestAuthToken);
#else
    setenv("SWARM_AUTH_TOKEN", kTestAuthToken, 1);
#endif
}
```

Add a call to `setTestAuthTokenEnv();` as the first line of both `NodeAgentFixture::SetUp()` and `MultiNodeAgentFixture::SetUp()` (before `KillAnyRunningAgent();` in each).

Update `waitForAgentHealth` (shared by every fixture) to send the token, since `/health` will now require it — without this fix every single existing test in this file times out after 20 seconds:

```cpp
void waitForAgentHealth(int port) {
    for (int attempt = 0; attempt < 100; ++attempt) {
        try {
            std::string response = sendRawRequest(
                port,
                "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
            if (response.find("HTTP/1.1 200") != std::string::npos) {
                return;
            }
        } catch (const std::exception&) {
            // not up yet -- keep polling
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    FAIL() << "swarm-node-agent on port " << port << " did not become healthy within 20 seconds";
}
```

Update every existing `TEST_F` in this file to include the `Authorization` header in its raw request (otherwise each now gets `401` instead of the status it's actually testing for). Replace each of the following five tests' bodies exactly as shown:

```cpp
TEST_F(NodeAgentFixture, HealthEndpointReportsReady) {
    std::string response = sendRawRequest(
        kAgentPort,
        "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"status\":\"ready\""), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointReturnsRealGeneratedText) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"text\":\""), std::string::npos);
    size_t textStart = response.find("\"text\":\"") + 8;
    size_t textEnd = response.find('"', textStart);
    ASSERT_NE(textEnd, std::string::npos);
    EXPECT_GT(textEnd - textStart, 0u);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsAMissingPromptWith400) {
    std::string body = R"({"n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsAnOversizedNPredictWith400) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":9999})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}
```

```cpp
TEST_F(MultiNodeAgentFixture, CompleteEndpointWorksAcrossRealRpcShardedInference) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    ASSERT_NE(response.find("HTTP/1.1 200"), std::string::npos) << response;
    size_t textStart = response.find("\"text\":\"");
    ASSERT_NE(textStart, std::string::npos) << response;
    textStart += 8;
    size_t textEnd = response.find('"', textStart);
    ASSERT_NE(textEnd, std::string::npos) << response;
    EXPECT_GT(textEnd - textStart, 0u) << response;
}
```

(Keep each test's existing doc comments in place above them — only the body content shown above changes.)

Add three new tests, after `CompleteEndpointRejectsAnOversizedNPredictWith400` and before `MultiNodeAgentFixture`'s test:

```cpp
TEST_F(NodeAgentFixture, HealthEndpointRejectsMissingAuthWith401) {
    std::string response = sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    EXPECT_NE(response.find("HTTP/1.1 401"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsMissingAuthWith401) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 401"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsWrongAuthWith401) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer wrong-token\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 401"), std::string::npos);
}
```

- [ ] **Step 2: Build and run to verify the new tests fail**

Run: `cmake --build build`
Run: `./build/core/tests/node_agent_test.exe`
Expected: `HealthEndpointRejectsMissingAuthWith401`, `CompleteEndpointRejectsMissingAuthWith401`, and `CompleteEndpointRejectsWrongAuthWith401` FAIL (the agent doesn't check auth yet, so these get `200`/`400` instead of `401`). All other tests should still PASS at this point (Step 1's header additions don't hurt anything yet since the agent doesn't require the header).

- [ ] **Step 3: Implement in `node_agent_main.cpp`**

Add `#include <cstdlib>` to the top of `core/src/node_agent_main.cpp` (for `std::getenv`), alongside the existing includes:

```cpp
#include "swarm/http_server.h"
#include "swarm/inference_engine.h"
#include "swarm/json_utils.h"

#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
```

Add these two helper functions to the anonymous namespace, after `parseLayerPlacement`:

```cpp
// Constant-time comparison -- a `==` on a secret-derived string is a
// timing side-channel (an attacker who can measure response latency could
// infer the token byte-by-byte from where the comparison first diverges).
bool constantTimeEquals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) {
        return false;
    }
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
    }
    return diff == 0;
}

bool isAuthorized(const swarm::HttpRequest& req, const std::string& token) {
    auto it = req.headers.find("authorization");
    if (it == req.headers.end()) {
        return false;
    }
    return constantTimeEquals(it->second, "Bearer " + token);
}
```

In `main()`, right after the existing `if (modelPath.empty() || port <= 0) { ... }` usage-check block (around line 62), add the token check:

```cpp
        const char* tokenEnv = std::getenv("SWARM_AUTH_TOKEN");
        if (tokenEnv == nullptr || std::string(tokenEnv).empty()) {
            std::fprintf(stderr, "error: SWARM_AUTH_TOKEN environment variable must be set -- refusing to start unauthenticated\n");
            return 1;
        }
        std::string authToken = tokenEnv;
```

Update both `server.route(...)` calls to check auth first. The `/health` route:

```cpp
        server.route("GET", "/health", [&authToken](const swarm::HttpRequest& req) {
            if (!isAuthorized(req, authToken)) {
                return swarm::HttpResponse{401, R"({"error":"missing or invalid Authorization header"})"};
            }
            return swarm::HttpResponse{200, R"({"status":"ready"})"};
        });
```

The `/complete` route (add `&authToken` to the existing capture list, and the check as the first lines of the handler body):

```cpp
        server.route("POST", "/complete", [&engine, &authToken](const swarm::HttpRequest& req) -> swarm::HttpResponse {
            if (!isAuthorized(req, authToken)) {
                return swarm::HttpResponse{401, R"({"error":"missing or invalid Authorization header"})"};
            }
            std::string prompt;
            if (!swarm::extractJsonString(req.body, "prompt", prompt)) {
                return swarm::HttpResponse{400, R"({"error":"prompt must be a JSON string field"})"};
            }
```

(The rest of the `/complete` handler body — `n_predict` parsing, the 512 cap, the `engine->complete(...)` call — is unchanged.)

- [ ] **Step 4: Build and run to verify everything passes**

Run: `cmake --build build`
Run: `./build/core/tests/node_agent_test.exe`
Expected: PASS, all tests (4 pre-existing `NodeAgentFixture` tests + 3 new 401 tests + 1 `MultiNodeAgentFixture` test = 8 total).

- [ ] **Step 5: Commit**

```bash
git add core/src/node_agent_main.cpp core/tests/node_agent_test.cpp
git commit -m "Require SWARM_AUTH_TOKEN on swarm-node-agent's /health and /complete"
```

---

### Task 7: Docs and full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the final behavior of every prior task (log message text from Task 2, endpoint list from Task 1, etc.).
- Produces: nothing consumed by later tasks — this is the last task in this plan.

- [ ] **Step 1: Add a "Running with authentication" setup section**

In `README.md`, add a new section right after the existing "## Coordinator service" section's introductory paragraphs but before its endpoint list (find the exact insertion point by reading the current file — it should sit near the top of that section, since every endpoint documented below it now requires this). Content:

```markdown
### Authentication

Every coordinator endpoint except the static dashboard shell (`GET /`,
`/app.js`, `/style.css`) and the OpenAPI document (`GET /openapi.json`)
requires a shared secret, set as the `SWARM_AUTH_TOKEN` environment
variable, sent as `Authorization: Bearer <token>`. The coordinator refuses
to start if `SWARM_AUTH_TOKEN` is unset:

```bash
SWARM_AUTH_TOKEN=<your-secret> PORT=8080 node src/main.ts
```

`swarm-node-agent` requires the *same* token (one shared secret across the
whole swarm, not per-node) on both `/health` and `/complete`:

```bash
SWARM_AUTH_TOKEN=<your-secret> ./build/core/swarm-node-agent.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8081
```

This closes "anyone can register a fake node, submit inference requests,
or read swarm state" for anyone who doesn't have the token — it does
**not** add encryption-in-transit (traffic is still plain HTTP) and it
does **not** stop a legitimate token-holder from misbehaving (registering
many fake nodes, claiming a `servesModel` they don't actually serve,
etc. — see the gaming-vector notes throughout this doc, most of which are
about token-holder behavior, not outsider access). For encryption, or for
running nodes across anything wider than a single trusted LAN, put an SSH
tunnel or WireGuard in front — see `swarm-rpc-server`'s note below, which
applies equally here.
```

- [ ] **Step 2: Update `swarm-rpc-server`'s existing warning with the tunnel recommendation**

Find the existing `[!WARNING]` block for `swarm-rpc-server` (currently ends with `"...and currently binds to \`127.0.0.1\` for exactly this reason."`). Add one sentence to the end of that same blockquote:

```markdown
> [!WARNING]
> The underlying llama.cpp RPC backend is, in upstream's own words, "in a
> proof-of-concept development stage. As such, the functionality is fragile
> and insecure." **Never run `swarm-rpc-server` on an open or untrusted
> network.** It has no authentication or encryption. It is suitable for
> trusted LAN or same-host use only, and currently binds to `127.0.0.1` for
> exactly this reason. If you need it reachable across more than one
> trusted machine, put it behind an SSH tunnel (`ssh -L`) or WireGuard
> rather than exposing the port directly — this gets you both
> authentication (the tunnel's own key-based auth) and encryption for
> free, without any code change here.
```

- [ ] **Step 3: Update `swarm-node-agent`'s warning (added earlier this session) to reflect that auth now exists**

Find the `[!WARNING]` block in the "## Node agent" section (currently starts `"swarm-node-agent's HTTP endpoints (/health, /complete) have no authentication or encryption of their own..."`). Replace it with:

```markdown
> [!WARNING]
> `swarm-node-agent`'s HTTP endpoints (`/health`, `/complete`) require the
> shared `SWARM_AUTH_TOKEN` (see the Coordinator service section's
> Authentication subsection above) but still have no encryption of their
> own — traffic is plain HTTP. It binds to `127.0.0.1` by default; there is
> currently no `--host` flag to bind another interface. If you need it
> reachable across more than one trusted machine, put it behind an SSH
> tunnel or WireGuard rather than exposing the port directly, matching
> `swarm-rpc-server`'s recommendation above.
```

- [ ] **Step 4: Update the five "no-auth caveat" cross-references**

Five spots in the README currently say some variant of "no authentication" or "the no-auth caveat" as an *active, current* gap. Each now needs to say auth exists but the specific behavior it doesn't prevent (a legitimate token-holder still being able to do the thing being described) — do not just delete these sentences, since the underlying gaming vector they describe (among token-holders) is still real and still worth disclosing. Use this exact principle for each: **replace "no authentication" / "the no-auth posture" with "the shared-token authentication (see Authentication above) — anyone who has the token, not literally anyone" **, keeping the rest of each sentence's actual point intact.

Two of the five spots, done as concrete examples (the current text was read directly from the file in this session):

The `POST /generate` node-registration gaming vector currently reads *"Combined with the no-auth posture, this means anyone can register an endpoint claiming to serve a given model..."* — change to: *"Combined with this, anyone who has the shared `SWARM_AUTH_TOKEN` — not the general public, but any single compromised or dishonest swarm member — can register an endpoint claiming to serve a given model..."*

The peer-federation caveat currently reads *"**Caveat:** there is no authentication, and by default the server binds only to \`127.0.0.1\`..."* followed by *"...and \`POST /peers/register\` itself is unauthenticated, so anyone able to reach this instance can add outbound request targets."* — change to: *"**Caveat:** `POST /peers/register` now requires \`SWARM_AUTH_TOKEN\` (see Authentication above), and by default the server binds only to \`127.0.0.1\`..."* and *"...so anyone who has the token can add outbound request targets — this is a smaller set than 'anyone on the network' but is not 'only operators who should be adding peers,' since there's still only the one shared token, not per-operator credentials."*

Find and apply the same treatment (auth narrows "anyone" to "anyone with the token," the underlying gaming vector among token-holders remains and stays disclosed) to the remaining three: the reputation-gaming section's *"...ones; see the no-auth caveat below."*, the locality-group section's *"...(the same no-auth caveat above applies here too)"*, and the dashboard/classify-demo section's *"...same-origin only, with no authentication — matching the coordinator's existing no-auth posture described above."*

- [ ] **Step 5: Full build and test verification**

Run: `cmake --build build`
Expected: builds cleanly, no errors.

Run: `cd build && ctest`
Expected: all tests pass, including `http_server_test` and `node_agent_test`.

Run: `cd coordinator && npm test`
Expected: all tests pass.

Run: `cd coordinator && npm run test:e2e`
Expected: either passes (if the node-agent binary and test model are present) or self-skips with its documented skip message — not a hard failure either way.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document SWARM_AUTH_TOKEN setup and update stale no-auth claims"
```
