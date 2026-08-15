import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ModelCatalog, type CatalogEntry } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";

const DEFAULT_TEST_CATALOG: CatalogEntry[] = [
  { id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 },
  { id: "small-7b", displayName: "Small 7-8B dense model", minActiveNodes: 1 },
];

async function startTestServer(catalogEntries: CatalogEntry[] = DEFAULT_TEST_CATALOG) {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog(catalogEntries);
  const peers = new PeerRegistry();
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
