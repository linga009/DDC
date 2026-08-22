import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { createServer, selectNode } from "../src/server.ts";
import { NodeRegistry, type NodeInfo } from "../src/registry.ts";
import { ModelCatalog, type CatalogEntry } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";
import { KeywordSafetyClassifier, type SafetyClassifier } from "../src/safety_classifier.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import { openApiDocument } from "../src/openapi.ts";

const DEFAULT_TEST_CATALOG: CatalogEntry[] = [
  { id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 },
  { id: "small-7b", displayName: "Small 7-8B dense model", minActiveNodes: 1 },
];

const TEST_AUTH_TOKEN = "test-secret-token-1234";

async function startTestServer(
  catalogEntries: CatalogEntry[] = DEFAULT_TEST_CATALOG,
  peers: PeerRegistry = new PeerRegistry(),
  classifier: SafetyClassifier = new KeywordSafetyClassifier([]),
  reputation: ReputationTracker = new ReputationTracker(),
  authToken: string = TEST_AUTH_TOKEN,
  random: () => number = Math.random,
) {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog(catalogEntries);
  const server = createServer(registry, catalog, peers, classifier, reputation, authToken, random);

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

test("selectNode returns undefined when no candidate matches the requested model", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "other-model" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result, undefined);
});

test("selectNode returns the single matching candidate without calling random", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result?.nodeId, "a");
});

test("selectNode picks the higher-scoring candidate without calling random", () => {
  const reputation = new ReputationTracker();
  reputation.recordAgreement("good");
  reputation.recordAgreement("good");
  reputation.recordAgreement("good");
  reputation.recordDisagreement("bad");
  reputation.recordDisagreement("bad");
  reputation.recordDisagreement("bad");
  const nodes: NodeInfo[] = [
    { nodeId: "bad", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "good", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result?.nodeId, "good");
});

test("selectNode breaks a tie using the injected random function, low end of the range", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "b", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "c", endpoint: "http://z", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => 0);
  assert.equal(result?.nodeId, "a");
});

test("selectNode breaks a tie using the injected random function, high end of the range", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "b", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "c", endpoint: "http://z", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => 0.999);
  assert.equal(result?.nodeId, "c");
});

test("selectNode ignores candidates that don't match the requested model even when they score higher", () => {
  const reputation = new ReputationTracker();
  reputation.recordAgreement("wrong-model-node");
  reputation.recordAgreement("wrong-model-node");
  const nodes: NodeInfo[] = [
    { nodeId: "wrong-model-node", endpoint: "http://x", deviceTier: "desktop", servesModel: "small-7b" },
    { nodeId: "right-model-node", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result?.nodeId, "right-model-node");
});

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

test("a 401 carries the WWW-Authenticate header RFC 7235 requires", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 401);
    // RFC 7235 section 3.1: a 401 MUST carry WWW-Authenticate naming the
    // scheme, which is how a generic HTTP client knows what credential to
    // supply rather than just seeing an opaque rejection.
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
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

test("POST /nodes/register returns a nodeId and the node appears in the catalog's active count", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    assert.equal(registerRes.status, 200);
    const { nodeId } = await registerRes.json();
    assert.equal(typeof nodeId, "string");

    const catalogRes = await authFetch(`${baseUrl}/catalog`);
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
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await registerRes.json();

    const goodHeartbeat = await authFetch(`${baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST" });
    assert.equal(goodHeartbeat.status, 204);

    const badHeartbeat = await authFetch(`${baseUrl}/nodes/not-a-real-id/heartbeat`, { method: "POST" });
    assert.equal(badHeartbeat.status, 404);
  } finally {
    server.close();
  }
});

test("GET /nodes lists active nodes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });

    const res = await authFetch(`${baseUrl}/nodes`);
    const nodes = await res.json();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].endpoint, "http://127.0.0.1:50052");
  } finally {
    server.close();
  }
});

test("POST /nodes/register with malformed JSON returns 400 and the server survives to handle further requests", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const badRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json{",
    });
    assert.equal(badRes.status, 400);
    const badBody = await badRes.json();
    assert.equal(typeof badBody.error, "string");

    // Prove the process/server is still alive and functioning: a subsequent,
    // well-formed request must still succeed rather than hanging or erroring
    // due to a crashed/unhandled-rejection process.
    const goodRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    assert.equal(goodRes.status, 200);
    const { nodeId } = await goodRes.json();
    assert.equal(typeof nodeId, "string");
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects a non-string endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: { a: 1 }, deviceTier: "desktop" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects a scheme-less endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");

    // Confirm nothing was actually registered.
    const nodesRes = await authFetch(`${baseUrl}/nodes`);
    assert.equal((await nodesRes.json()).length, 0);
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects a non-http(s) scheme endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "ftp://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");

    // Confirm nothing was actually registered.
    const nodesRes = await authFetch(`${baseUrl}/nodes`);
    assert.equal((await nodesRes.json()).length, 0);
  } finally {
    server.close();
  }
});

test("POST /nodes/register normalizes away a trailing slash on endpoint", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052/", deviceTier: "desktop" }),
    });
    assert.equal(res.status, 200);

    const nodes = await (await authFetch(`${baseUrl}/nodes`)).json();
    assert.equal(nodes[0].endpoint, "http://127.0.0.1:50052");
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects an invalid deviceTier with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "toaster" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  } finally {
    server.close();
  }
});

test("POST /nodes/register with a JSON body of literal null returns 400, not 500", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  } finally {
    server.close();
  }
});

test("GET /catalog with zero active nodes only shows the zero-threshold model available", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/catalog`);
    const catalog = await res.json();
    assert.equal(catalog.find((e: any) => e.id === "tinyllama-1.1b").available, true);
    assert.equal(catalog.find((e: any) => e.id === "small-7b").available, false);
  } finally {
    server.close();
  }
});

test("GET /capacity reports the active node count", async () => {
  const { server, baseUrl, registry } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });

    const res = await authFetch(`${baseUrl}/capacity`);
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
    const registerRes = await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://192.168.1.50:9090" }),
    });
    assert.equal(registerRes.status, 200);
    const { peerId } = await registerRes.json();
    assert.equal(typeof peerId, "string");

    const listRes = await authFetch(`${baseUrl}/peers`);
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
    const registerRes = await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://192.168.1.50:9090" }),
    });
    const { peerId } = await registerRes.json();

    const deleteRes = await authFetch(`${baseUrl}/peers/${peerId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 204);

    const listRes = await authFetch(`${baseUrl}/peers`);
    assert.equal((await listRes.json()).length, 0);

    const deleteAgain = await authFetch(`${baseUrl}/peers/${peerId}`, { method: "DELETE" });
    assert.equal(deleteAgain.status, 404);
  } finally {
    server.close();
  }
});

test("POST /peers/register rejects a non-URL endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "not-a-url-at-all" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");

    // Confirm nothing was actually registered.
    const listRes = await authFetch(`${baseUrl}/peers`);
    assert.equal((await listRes.json()).length, 0);
  } finally {
    server.close();
  }
});

test("POST /peers/register rejects a non-http(s) scheme endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "file:///etc/passwd" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");

    // Confirm nothing was actually registered.
    const listRes = await authFetch(`${baseUrl}/peers`);
    assert.equal((await listRes.json()).length, 0);
  } finally {
    server.close();
  }
});

test("POST /peers/:peerId/heartbeat keeps a peer active past what would otherwise be its expiry", async () => {
  // Inject a fake clock and a short timeout so we can prove the heartbeat
  // actually extends the peer's life, deterministically and without a real
  // 30-second wait.
  let now = 0;
  const peers = new PeerRegistry(() => now, 1000);
  const { server, baseUrl } = await startTestServer(DEFAULT_TEST_CATALOG, peers);
  try {
    const registerRes = await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://192.168.1.50:9090" }),
    });
    const { peerId } = await registerRes.json();

    // Still within the original 1000ms window -- heartbeat should succeed
    // and refresh lastSeen.
    now = 700;
    const heartbeatRes = await authFetch(`${baseUrl}/peers/${peerId}/heartbeat`, { method: "POST" });
    assert.equal(heartbeatRes.status, 204);

    // 1500ms after registration -- past the ORIGINAL 1000ms window, but
    // only 800ms after the heartbeat refreshed lastSeen, so still within a
    // fresh window. Without the heartbeat route/refresh, this peer would
    // already be expired (1500 - 0 > 1000).
    now = 1500;
    const listRes = await authFetch(`${baseUrl}/peers`);
    const list = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].peerId, peerId);
  } finally {
    server.close();
  }
});

test("POST /peers/:peerId/heartbeat returns 404 for an unknown peer", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/peers/not-a-real-id/heartbeat`, { method: "POST" });
    assert.equal(res.status, 404);
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
  await authFetch(`${baseUrlB}/nodes/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
  });

  const { server: serverA, baseUrl: baseUrlA } = await startTestServer(catalogEntries);

  try {
    // A has zero local nodes -- confirm the model is NOT available yet.
    const beforeRes = await authFetch(`${baseUrlA}/catalog`);
    const before = await beforeRes.json();
    assert.equal(before.find((e: any) => e.id === "small").available, false);

    // A federates with B.
    await authFetch(`${baseUrlA}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: baseUrlB }),
    });

    // Now A's catalog should reflect B's capacity too.
    const afterRes = await authFetch(`${baseUrlA}/catalog`);
    const after = await afterRes.json();
    assert.equal(after.find((e: any) => e.id === "small").available, true);
  } finally {
    serverA.close();
    serverB.close();
  }
});

test("GET /catalog sends the shared auth token on its outbound /capacity request to a peer", async () => {
  // The peer-federation tests around this one all use stub peers that never
  // look at the inbound Authorization header, so every one of them would
  // pass whether or not fetchPeerCapacity() authenticates at all. Now that
  // GET /capacity requires a token, a peer that isn't sent one contributes
  // 0 -- silently zeroing federated capacity. Assert the header for real.
  const catalogEntries = [
    { id: "small", displayName: "Small", minActiveNodes: 1 },
  ];

  let receivedAuth: string | null | undefined;
  let receivedPath: string | undefined;
  const testPeer = createHttpServer((req, res) => {
    if (req.url === "/capacity") {
      receivedPath = req.url;
      receivedAuth = req.headers.authorization ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ activeNodes: 3 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => testPeer.listen(0, "127.0.0.1", resolve));
  const testPeerAddress = testPeer.address();
  if (testPeerAddress === null || typeof testPeerAddress === "string") {
    throw new Error("expected test peer to bind a real port");
  }

  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${testPeerAddress.port}` }),
    });

    const res = await authFetch(`${baseUrl}/catalog`);
    assert.equal(res.status, 200);

    assert.equal(receivedPath, "/capacity", "the coordinator never polled the peer at all");
    assert.equal(receivedAuth, `Bearer ${TEST_AUTH_TOKEN}`);
  } finally {
    server.close();
    testPeer.close();
  }
});

test("GET /catalog degrades gracefully when a registered peer is unreachable", async () => {
  const catalogEntries = [
    { id: "small", displayName: "Small", minActiveNodes: 1 },
  ];
  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    // Register a peer endpoint that nothing is listening on.
    await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:1" }),
    });

    const res = await authFetch(`${baseUrl}/catalog`);
    assert.equal(res.status, 200);
    const catalog = await res.json();
    // Should not throw, hang, or 500 -- the unreachable peer just
    // contributes 0.
    assert.equal(catalog.find((e: any) => e.id === "small").available, false);
  } finally {
    server.close();
  }
});

test("GET /catalog treats a peer reporting negative activeNodes as contributing 0, not corrupting the aggregate", async () => {
  const catalogEntries = [
    { id: "small", displayName: "Small", minActiveNodes: 1 },
  ];

  // A misbehaving peer that reports a negative capacity.
  const fakePeer = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ activeNodes: -10 }));
  });
  await new Promise<void>(resolve => fakePeer.listen(0, "127.0.0.1", resolve));
  const fakePeerAddress = fakePeer.address();
  if (fakePeerAddress === null || typeof fakePeerAddress === "string") {
    throw new Error("expected fake peer to bind a real port");
  }
  const fakePeerUrl = `http://127.0.0.1:${fakePeerAddress.port}`;

  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    // Give the local instance enough REAL local capacity to serve the
    // model entirely on its own.
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });

    await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fakePeerUrl }),
    });

    const res = await authFetch(`${baseUrl}/catalog`);
    assert.equal(res.status, 200);
    const catalog = await res.json();
    // Local capacity alone (1) meets minActiveNodes (1). The malicious
    // peer's -10 must contribute 0, not subtract from local truth and flip
    // an available model to unavailable.
    assert.equal(catalog.find((e: any) => e.id === "small").available, true);
  } finally {
    server.close();
    fakePeer.close();
  }
});

test("GET /catalog correctly reflects a peer's capacity even when registered with a trailing-slash endpoint", async () => {
  const catalogEntries = [
    { id: "small", displayName: "Small", minActiveNodes: 1 },
  ];

  // A real test-peer server reporting real, non-zero capacity.
  const testPeer = createHttpServer((req, res) => {
    if (req.url === "/capacity") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ activeNodes: 3 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => testPeer.listen(0, "127.0.0.1", resolve));
  const testPeerAddress = testPeer.address();
  if (testPeerAddress === null || typeof testPeerAddress === "string") {
    throw new Error("expected test peer to bind a real port");
  }
  // Deliberately register WITH a trailing slash.
  const testPeerUrlWithSlash = `http://127.0.0.1:${testPeerAddress.port}/`;

  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: testPeerUrlWithSlash }),
    });

    const res = await authFetch(`${baseUrl}/catalog`);
    assert.equal(res.status, 200);
    const catalog = await res.json();
    // If the trailing slash weren't normalized away, the outbound fetch
    // would hit a malformed URL (double slash before "capacity"), 404, and
    // silently contribute 0 -- leaving the model unavailable despite real
    // capacity.
    assert.equal(catalog.find((e: any) => e.id === "small").available, true);
  } finally {
    server.close();
    testPeer.close();
  }
});

test("POST /classify returns safe:true for a prompt matching no configured rules", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "an ordinary prompt" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, true);
    assert.deepEqual(body.categories, []);
  } finally {
    server.close();
  }
});

test("POST /classify returns safe:false and categories for a prompt matching a configured rule", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /UNSAFE_TEST_TOKEN/, category: "test_category" },
  ]);
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "contains UNSAFE_TEST_TOKEN here" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, false);
    assert.deepEqual(body.categories, ["test_category"]);
  } finally {
    server.close();
  }
});

test("POST /classify reports a category once even when several rules in that category match", async () => {
  // The classifier emits one entry per matching RULE. With a real 70-rule
  // ruleset, a single prompt trivially trips two rules in the same category,
  // which used to surface as {"categories":["violence_and_weapons",
  // "violence_and_weapons"]} in the response body and in the dashboard UI.
  const classifier = new KeywordSafetyClassifier([
    { pattern: /FIRST_RULE/, category: "same_category" },
    { pattern: /SECOND_RULE/, category: "same_category" },
    { pattern: /OTHER_RULE/, category: "other_category" },
  ]);
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "trips FIRST_RULE and SECOND_RULE and OTHER_RULE" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, false);
    // De-duplicated, and first-seen order preserved -- not sorted, not
    // collapsed to a single category.
    assert.deepEqual(body.categories, ["same_category", "other_category"]);
  } finally {
    server.close();
  }
});

test("POST /classify still reports every DISTINCT category a prompt matches", async () => {
  // Guards against "de-duplicate" being implemented as "report only the
  // first match".
  const classifier = new KeywordSafetyClassifier([
    { pattern: /ALPHA/, category: "cat_a" },
    { pattern: /BETA/, category: "cat_b" },
    { pattern: /GAMMA/, category: "cat_c" },
  ]);
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "ALPHA BETA GAMMA" }),
    });
    const body = await res.json();
    assert.deepEqual(body.categories, ["cat_a", "cat_b", "cat_c"]);
  } finally {
    server.close();
  }
});

test("POST /classify rejects a request with a missing or non-string prompt", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: 12345 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /classify fails closed (safe:false) if the classifier itself throws", async () => {
  const throwingClassifier: SafetyClassifier = {
    classify: async () => {
      throw new Error("classifier backend unavailable");
    },
  };
  const { server, baseUrl } = await startTestServer(undefined, undefined, throwingClassifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "anything" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, false);
    assert.ok(body.categories.length > 0);
  } finally {
    server.close();
  }
});

const MALFORMED_CLASSIFIER_RESULTS: Array<{ name: string; value: unknown }> = [
  { name: "safe is a string instead of a boolean", value: { safe: "yes", categories: [] } },
  { name: "categories is missing entirely", value: { safe: true } },
  { name: "null", value: null },
  { name: "undefined", value: undefined },
];

for (const { name, value } of MALFORMED_CLASSIFIER_RESULTS) {
  test(`POST /classify fails closed (safe:false) when the classifier returns a malformed result: ${name}`, async () => {
    const malformedClassifier: SafetyClassifier = {
      classify: async () => value as any,
    };
    const { server, baseUrl } = await startTestServer(undefined, undefined, malformedClassifier);
    try {
      const res = await authFetch(`${baseUrl}/classify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "anything" }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { safe: false, categories: ["classifier_error"] });
    } finally {
      server.close();
    }
  });
}

test("POST /classify serializes the VALIDATED safe/categories values, not whatever a toJSON() override on the result object would produce", async () => {
  // Plain property access (what validation reads) says unsafe. A toJSON()
  // method on the same object (what a naive JSON.stringify(result) would
  // invoke during serialization) lies and says safe. The response must
  // reflect the validated properties, proving the route doesn't forward the
  // original result object by reference into sendJson.
  const deceptiveClassifier: SafetyClassifier = {
    classify: async () => ({
      safe: false,
      categories: ["blocked"],
      toJSON() {
        return { safe: true, categories: [] };
      },
    }) as any,
  };
  const { server, baseUrl } = await startTestServer(undefined, undefined, deceptiveClassifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "anything" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, false);
    assert.deepEqual(body.categories, ["blocked"]);
  } finally {
    server.close();
  }
});

test("POST /classify drops extra fields on the classifier's result object -- only safe/categories reach the HTTP response", async () => {
  const chattyClassifier: SafetyClassifier = {
    classify: async () => ({
      safe: false,
      categories: ["blocked"],
      internalReasoning: "should not leak to the HTTP caller",
    }) as any,
  };
  const { server, baseUrl } = await startTestServer(undefined, undefined, chattyClassifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "anything" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { safe: false, categories: ["blocked"] });
  } finally {
    server.close();
  }
});

test("POST /classify fails closed (safe:false) if the classifier hangs forever", async () => {
  const hangingClassifier: SafetyClassifier = {
    classify: () => new Promise(() => {}),
  };
  const { server, baseUrl } = await startTestServer(undefined, undefined, hangingClassifier);
  try {
    const res = await authFetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "anything" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { safe: false, categories: ["classifier_error"] });
  } finally {
    server.close();
  }
});

test("POST /nodes/:nodeId/reputation/agree and /disagree record events, GET reports them", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await registerRes.json();

    await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });

    const statsRes = await authFetch(`${baseUrl}/nodes/${nodeId}/reputation`);
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.equal(stats.agreements, 2);
    assert.equal(stats.disagreements, 1);
    assert.equal(stats.trusted, true);
  } finally {
    server.close();
  }
});

test("reputation endpoints return 404 for an unknown nodeId", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/never-registered/reputation/agree`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("a node ejected by reputation disappears from GET /nodes and stops counting toward catalog capacity", async () => {
  const catalogEntries = [{ id: "small", displayName: "Small", minActiveNodes: 1 }];
  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await registerRes.json();

    const beforeCatalog = await (await authFetch(`${baseUrl}/catalog`)).json();
    assert.equal(beforeCatalog.find((e: any) => e.id === "small").available, true);

    for (let i = 0; i < 5; i++) {
      await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    }

    const nodesRes = await authFetch(`${baseUrl}/nodes`);
    assert.equal((await nodesRes.json()).length, 0);

    const afterCatalog = await (await authFetch(`${baseUrl}/catalog`)).json();
    assert.equal(afterCatalog.find((e: any) => e.id === "small").available, false);

    const capacityRes = await authFetch(`${baseUrl}/capacity`);
    assert.equal(capacityRes.status, 200);
    assert.deepEqual(await capacityRes.json(), { activeNodes: 0 });

    // Even though the node is ejected from capacity-facing views (GET /nodes,
    // GET /capacity, /catalog), it is still a real, registered node, and the
    // reputation endpoints must remain operable against it -- the existence
    // check for those routes deliberately uses the unfiltered listActive().
    const agreeAfterEjection = await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    assert.equal(agreeAfterEjection.status, 204);
  } finally {
    server.close();
  }
});

test("a node ejected by reputation stays ejected after re-registering the same endpoint -- reputation is not reset by churn", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId: firstNodeId } = await registerRes.json();

    for (let i = 0; i < 5; i++) {
      await authFetch(`${baseUrl}/nodes/${firstNodeId}/reputation/disagree`, { method: "POST" });
    }

    const ejectedNodes = await (await authFetch(`${baseUrl}/nodes`)).json();
    assert.equal(ejectedNodes.length, 0);

    // Re-register the exact same endpoint -- this is the live-verified
    // vector from README's "Known gaming vectors" section: before this
    // plan, this returned a brand-new randomUUID() nodeId with a clean
    // reputation record, restoring the node to GET /nodes immediately.
    const reregisterRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId: secondNodeId } = await reregisterRes.json();

    assert.equal(secondNodeId, firstNodeId);

    const stillEjectedNodes = await (await authFetch(`${baseUrl}/nodes`)).json();
    assert.equal(stillEjectedNodes.length, 0);

    const statsRes = await authFetch(`${baseUrl}/nodes/${secondNodeId}/reputation`);
    assert.deepEqual(await statsRes.json(), { agreements: 0, disagreements: 5, trusted: false });
  } finally {
    server.close();
  }
});

test("registering the same endpoint under three different localityGroup values never shows more than one node in GET /nodes/locality", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    for (const group of ["kitchen-mesh", "office-mesh", "garage-mesh"]) {
      await authFetch(`${baseUrl}/nodes/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: group }),
      });
    }

    const localityRes = await authFetch(`${baseUrl}/nodes/locality`);
    const groups = await localityRes.json();

    assert.equal(groups["kitchen-mesh"], undefined);
    assert.equal(groups["office-mesh"], undefined);
    assert.equal(groups["garage-mesh"].length, 1);

    const nodesRes = await authFetch(`${baseUrl}/nodes`);
    assert.equal((await nodesRes.json()).length, 1);
  } finally {
    server.close();
  }
});

test("POST /nodes/register accepts an optional localityGroup and it is echoed back via GET /nodes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: "kitchen-mesh" }),
    });
    assert.equal(registerRes.status, 200);

    const nodes = await (await authFetch(`${baseUrl}/nodes`)).json();
    assert.equal(nodes[0].localityGroup, "kitchen-mesh");
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects a non-string localityGroup", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: 42 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects an empty-string localityGroup", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: "" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("GET /nodes/locality groups registered nodes by their localityGroup, with ungrouped nodes bucketed separately", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: "kitchen-mesh" }),
    });
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50053", deviceTier: "android" }),
    });

    const res = await authFetch(`${baseUrl}/nodes/locality`);
    assert.equal(res.status, 200);
    const groups = await res.json();
    assert.equal(groups["kitchen-mesh"].length, 1);
    assert.equal(groups["ungrouped"].length, 1);
  } finally {
    server.close();
  }
});

test("GET /nodes/locality excludes a node ejected by reputation", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: "kitchen-mesh" }),
    });
    const { nodeId } = await registerRes.json();

    for (let i = 0; i < 5; i++) {
      await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    }

    const groups = await (await authFetch(`${baseUrl}/nodes/locality`)).json();
    assert.equal(groups["kitchen-mesh"], undefined);
  } finally {
    server.close();
  }
});

test("GET / serves index.html with text/html content-type", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<title>/);
  } finally {
    server.close();
  }
});

test("GET /app.js serves app.js with application/javascript content-type", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  } finally {
    server.close();
  }
});

test("GET /style.css serves style.css with text/css content-type", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/style.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  } finally {
    server.close();
  }
});

test("GET /nonexistent-static-file.js still 404s (no interference with existing routes)", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nonexistent-static-file.js`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// Regression coverage for the path-traversal-impossible-by-construction
// invariant documented in the comment above `serveStaticFile` in
// server.ts: `serveStaticFile` is only ever called with one of three
// hardcoded literal filenames, never a value derived from `req.url`/`parts`.
// If a future refactor introduced a generic `GET /public/:filename` route
// that built a filesystem path from the request, these tests would start
// failing.
//
// Node's `fetch`/`URL` normalize ".." segments client-side before a request
// is ever sent on the wire -- verified by inspecting the raw request line a
// `fetch()` call to these URLs actually produces: `/app.js/../server.ts`
// is sent as `GET /server.ts HTTP/1.1`, and `/../../package.json` is sent
// as `GET /package.json HTTP/1.1`. So this first test exercises "does a
// path containing '..' ever result in an unexpected file being served",
// but the ".." never reaches the server as a literal path segment through
// this client.
test("static routes reject path traversal attempts rather than serving arbitrary files", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res1 = await authFetch(`${baseUrl}/app.js/../server.ts`);
    assert.equal(res1.status, 404);

    const res2 = await authFetch(`${baseUrl}/../../package.json`);
    assert.equal(res2.status, 404);
  } finally {
    server.close();
  }
});

// This second test closes the gap above: it writes a raw HTTP request line
// containing a literal ".." segment directly to a socket, bypassing
// `fetch`'s client-side normalization entirely, to confirm what happens
// when ".." genuinely reaches the server. Verified live: the server's own
// `new URL(req.url, "http://localhost")` parsing (server.ts) also
// normalizes the dot-segments per the WHATWG URL spec before route
// matching runs, collapsing `/app.js/../../package.json` to `/package.json`
// -- which then 404s because no route matches a bare "package.json" or
// "server.ts" segment. Either way (client-side or server-side
// normalization), no request can escape `serveStaticFile`'s three hardcoded
// filenames.
test("a literal '..' path segment that survives to the server's own URL parsing still 404s", async () => {
  const { server, baseUrl, authToken } = await startTestServer();
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a real port");
  }
  try {
    // Authorization header included: the auth gate runs before route
    // matching, so an unauthenticated raw request would now hit 401 before
    // ever reaching the route logic this test targets. With a valid token
    // supplied, the request still reaches the same route-matching/404 path
    // this test was written to exercise.
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(address.port, "127.0.0.1", () => {
        socket.write(`GET /app.js/../../package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${authToken}\r\nConnection: close\r\n\r\n`);
      });
      let raw = "";
      socket.on("data", (chunk) => { raw += chunk.toString("utf-8"); });
      socket.on("end", () => resolve(raw.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
    assert.match(statusLine, /^HTTP\/1\.1 404/);
  } finally {
    server.close();
  }
});

test("existing GET /nodes route is unaffected by the new static routes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    server.close();
  }
});

test("index.html contains the expected element IDs app.js depends on, and the no-real-inference notice", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const body = await (await authFetch(`${baseUrl}/`)).text();
    assert.match(body, /id="active-count"/);
    assert.match(body, /id="catalog-table"/);
    assert.match(body, /id="prompt-input"/);
    assert.match(body, /id="classify-button"/);
    assert.match(body, /id="classify-result"/);
    assert.match(body, /does not run inference/i);
    assert.match(body, /id="chat-model-select"/);
    assert.match(body, /id="chat-history"/);
    assert.match(body, /id="chat-input"/);
    assert.match(body, /id="chat-send-button"/);
    assert.match(body, /id="chat-new-button"/);
  } finally {
    server.close();
  }
});

test("GET /nodes/locality safely handles a node that self-reports localityGroup \"__proto__\"", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: "__proto__" }),
    });

    const res = await authFetch(`${baseUrl}/nodes/locality`);
    assert.equal(res.status, 200);
    const rawText = await res.text();
    const body = JSON.parse(rawText);

    // Must be an OWN property, not the inherited Object.prototype accessor
    // (a buggy implementation that assigns via `obj["__proto__"] = nodes`
    // would trigger the legacy setter instead of creating an own key, so
    // `hasOwnProperty` is the only check that actually distinguishes the
    // two cases -- a truthiness check on body["__proto__"] would pass in
    // both the buggy and fixed cases).
    assert.equal(Object.prototype.hasOwnProperty.call(body, "__proto__"), true);
    assert.equal(body["__proto__"].length, 1);
    assert.equal(body["__proto__"][0].endpoint, "http://127.0.0.1:50052");

    // The object's actual prototype must remain untouched -- a buggy
    // implementation reassigns it to the nodes array via the legacy
    // __proto__ setter.
    assert.equal(Object.getPrototypeOf(body), Object.prototype);
  } finally {
    server.close();
  }
});

test("GET /openapi.json serves the OpenAPI document", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/openapi.json`);
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

test("openapi.json documents the bearer-token requirement it is deliberately left public to advertise", async () => {
  // /openapi.json is one of only four unauthenticated routes, and the stated
  // reason (see isPublicRoute in server.ts) is "a developer needs to be able
  // to read it to find out a token is even required." A document with no
  // securityScheme, no security requirement, and no 401 anywhere contradicts
  // its own reason for being public -- a developer generating a client from
  // it would produce one that 401s on every call with nothing explaining why.
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/openapi.json`);
    const doc = await res.json();

    assert.deepEqual(doc.components.securitySchemes.bearerAuth.type, "http");
    assert.deepEqual(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
    assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
    assert.match(doc.info.description, /Authorization: Bearer/);
    assert.match(doc.info.description, /SWARM_AUTH_TOKEN/);

    // Every documented operation must document its 401 -- all of them sit
    // behind the same pre-routing auth check, so any operation without one
    // is a documentation gap, not a route that can't 401.
    for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
      for (const [method, operation] of Object.entries(methods)) {
        assert.ok(
          operation.responses?.["401"],
          `${method.toUpperCase()} ${path} is documented without a 401, but every route requires the token`,
        );
      }
    }
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
    const nodeRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await nodeRes.json();
    const peerRes = await authFetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:9999" }),
    });
    const { peerId } = await peerRes.json();

    const substitute = (path: string) => path.replace("{nodeId}", nodeId).replace("{peerId}", peerId);

    for (const [path, methods] of Object.entries(openApiDocument.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(methods)) {
        const url = `${baseUrl}${substitute(path)}`;
        const res = await authFetch(url, {
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

// Like startStubNodeAgent, but for a POST /complete request with
// stream: true -- responds with a real SSE stream, writing each of
// `chunks` as its own "data: ...\n\n" frame with `delayMs` between writes,
// then a terminal "data: [DONE]\n\n" frame (matching the real
// swarm-node-agent's ResponseWriter::writeDone() behavior), so a caller
// relaying this incrementally (not buffering the whole thing) can be told
// apart from one that isn't, and so tests exercise the real terminal-frame
// wire shape Task 5 depends on.
async function startStreamingStubNodeAgent(chunks: string[], delayMs = 20) {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request body */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) {
      res.write(`data: ${chunk}\n\n`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected streaming stub node agent to bind to a port");
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

test("POST /generate classifies, routes to a matching node, and returns its response", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "Paris." } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
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
    const res = await authFetch(`${baseUrl}/generate`, {
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
    const res = await authFetch(`${baseUrl}/generate`, {
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
    const res = await authFetch(`${baseUrl}/generate`, {
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
    const res = await authFetch(`${baseUrl}/generate`, {
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
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:1", deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });
    assert.equal(res.status, 502);
  } finally {
    server.close();
  }
});

test("POST /generate's blocked-prompt body reports a category once even when several rules in it match", async () => {
  // /generate builds its own 400 body from a classification result, so the
  // de-duplication has to hold at both response-construction sites, not just
  // /classify's.
  const classifier = new KeywordSafetyClassifier([
    { pattern: /FIRST_RULE/, category: "same_category" },
    { pattern: /SECOND_RULE/, category: "same_category" },
  ]);
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "must not be reached" } }));
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "FIRST_RULE and SECOND_RULE", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { safe: false, categories: ["same_category"] });
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate excludes a reputation-ejected node from routing", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "should not be reached" } }));
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    const { nodeId } = await registerRes.json();

    for (let i = 0; i < 5; i++) {
      await authFetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    }

    const res = await authFetch(`${baseUrl}/generate`, {
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

test("POST /generate routes to the higher-scoring node when two trusted nodes serve the same model", async () => {
  const goodStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the well-reputed node" } }));
  const untestedStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the untested node" } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: untestedStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    const goodRegisterRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: goodStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    const { nodeId: goodNodeId } = await goodRegisterRes.json();

    for (let i = 0; i < 10; i++) {
      await authFetch(`${baseUrl}/nodes/${goodNodeId}/reputation/agree`, { method: "POST" });
    }

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from the well-reputed node" });
  } finally {
    server.close();
    goodStub.server.close();
    untestedStub.server.close();
  }
});

test("POST /generate breaks a tie between equally-scored nodes using the injected random function", async () => {
  const firstStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the first-registered node" } }));
  const secondStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the second-registered node" } }));
  const { server, baseUrl } = await startTestServer(undefined, undefined, undefined, undefined, undefined, () => 0.999);
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: firstStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: secondStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from the second-registered node" });
  } finally {
    server.close();
    firstStub.server.close();
    secondStub.server.close();
  }
});

test("POST /generate with stream:true relays SSE chunks from the node", async () => {
  const stub = await startStreamingStubNodeAgent(["Paris", " is", " nice"]);
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.equal(text, "data: Paris\n\ndata:  is\n\ndata:  nice\n\ndata: [DONE]\n\n");
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate with stream:true relays chunks as they arrive, not buffered until the end", async () => {
  const stub = await startStreamingStubNodeAgent(["first", "second"], 150);
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.ok(res.body);
    const reader = res.body!.getReader();
    const arrivalTimesMs: number[] = [];
    const start = Date.now();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      arrivalTimesMs.push(Date.now() - start);
    }

    // The stub sleeps 150ms between its two writes -- if the coordinator
    // buffered the whole response before relaying it, all reads would
    // arrive together near the end of the stub's total delay. Real
    // incremental relay means the first read arrives well before the stub
    // has even reached its own inter-chunk sleep.
    assert.ok(arrivalTimesMs.length >= 2, `expected at least 2 separate reads, got ${arrivalTimesMs.length}`);
    assert.ok(
      arrivalTimesMs[0] < 100,
      `first chunk arrived at ${arrivalTimesMs[0]}ms, expected well under the stub's 150ms inter-chunk delay`,
    );
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate with stream:true still classifies the prompt before contacting any node", async () => {
  const classifier = new KeywordSafetyClassifier([{ category: "test", pattern: /blocked/i }]);
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "this is blocked", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { safe: false, categories: ["test"] });
  } finally {
    server.close();
  }
});

test("POST /generate with stream:true returns a normal 502 when the selected node is unreachable", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:1", deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 502);
    assert.equal(res.headers.get("content-type"), "application/json");
  } finally {
    server.close();
  }
});

test("POST /generate with stream:true returns a clean 502 when the node ignores stream and answers JSON", async () => {
  // A pre-Phase-D node agent (or any node that doesn't understand
  // stream:true) responds 200 application/json regardless of what the
  // request asked for. Relaying that body under a text/event-stream
  // content-type would look like a well-formed, successfully-completed
  // empty stream to every consumer -- this must be caught and reported
  // instead, before any response headers are committed.
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "I am a pre-Phase-D node." } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 502);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate with stream:true relays a node's SSE response even with a mixed-case content-type header", async () => {
  // Content-Type is case-insensitive per RFC 9110 8.3 -- a federated node
  // running a different agent build could legally send "Text/Event-Stream"
  // instead of this repo's own lowercase convention. The relay's own
  // content-type check must not itself become a false-positive 502 for a
  // node that is behaving correctly.
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "Text/Event-Stream" });
    res.write("data: hi\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected mixed-case-content-type stub to bind a port");
  }
  const { server: coordServer, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: `http://127.0.0.1:${address.port}`,
        deviceTier: "desktop",
        servesModel: "tinyllama-1.1b",
      }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "data: hi\n\ndata: [DONE]\n\n");
  } finally {
    coordServer.close();
    server.close();
  }
});

test("POST /generate without a stream field behaves exactly as before", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "Paris." } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), { text: "Paris." });
  } finally {
    server.close();
    stub.server.close();
  }
});
