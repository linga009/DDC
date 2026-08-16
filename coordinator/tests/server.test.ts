import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ModelCatalog, type CatalogEntry } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";

const DEFAULT_TEST_CATALOG: CatalogEntry[] = [
  { id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 },
  { id: "small-7b", displayName: "Small 7-8B dense model", minActiveNodes: 1 },
];

async function startTestServer(
  catalogEntries: CatalogEntry[] = DEFAULT_TEST_CATALOG,
  peers: PeerRegistry = new PeerRegistry(),
) {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog(catalogEntries);
  const server = createServer(registry, catalog, peers);

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind a real port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, registry, peers };
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

test("POST /nodes/register with malformed JSON returns 400 and the server survives to handle further requests", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const badRes = await fetch(`${baseUrl}/nodes/register`, {
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
    const goodRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
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
    const res = await fetch(`${baseUrl}/nodes/register`, {
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

test("POST /nodes/register rejects an invalid deviceTier with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "toaster" }),
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
    const res = await fetch(`${baseUrl}/nodes/register`, {
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
    const res = await fetch(`${baseUrl}/catalog`);
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

test("POST /peers/register rejects a non-URL endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "not-a-url-at-all" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");

    // Confirm nothing was actually registered.
    const listRes = await fetch(`${baseUrl}/peers`);
    assert.equal((await listRes.json()).length, 0);
  } finally {
    server.close();
  }
});

test("POST /peers/register rejects a non-http(s) scheme endpoint with 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "file:///etc/passwd" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, "string");

    // Confirm nothing was actually registered.
    const listRes = await fetch(`${baseUrl}/peers`);
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
    const registerRes = await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://192.168.1.50:9090" }),
    });
    const { peerId } = await registerRes.json();

    // Still within the original 1000ms window -- heartbeat should succeed
    // and refresh lastSeen.
    now = 700;
    const heartbeatRes = await fetch(`${baseUrl}/peers/${peerId}/heartbeat`, { method: "POST" });
    assert.equal(heartbeatRes.status, 204);

    // 1500ms after registration -- past the ORIGINAL 1000ms window, but
    // only 800ms after the heartbeat refreshed lastSeen, so still within a
    // fresh window. Without the heartbeat route/refresh, this peer would
    // already be expired (1500 - 0 > 1000).
    now = 1500;
    const listRes = await fetch(`${baseUrl}/peers`);
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
    const res = await fetch(`${baseUrl}/peers/not-a-real-id/heartbeat`, { method: "POST" });
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
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });

    await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fakePeerUrl }),
    });

    const res = await fetch(`${baseUrl}/catalog`);
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
    await fetch(`${baseUrl}/peers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: testPeerUrlWithSlash }),
    });

    const res = await fetch(`${baseUrl}/catalog`);
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
