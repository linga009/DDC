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
