import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ModelCatalog } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";
import { KeywordSafetyClassifier } from "../src/safety_classifier.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import { SwarmClient } from "../src/client.ts";

const TEST_AUTH_TOKEN = "test-secret-token-1234";

async function startTestServer() {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog();
  const peers = new PeerRegistry();
  const classifier = new KeywordSafetyClassifier([]);
  const reputation = new ReputationTracker();
  const server = createServer(registry, catalog, peers, classifier, reputation, TEST_AUTH_TOKEN);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind to a port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

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

test("SwarmClient registers a node and lists it", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    const nodeId = await client.registerNode("http://127.0.0.1:50052", "desktop");
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
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    const nodeId = await client.registerNode("http://127.0.0.1:50052", "desktop");
    assert.equal(await client.heartbeat(nodeId), true);
    assert.equal(await client.heartbeat("never-registered"), false);
  } finally {
    server.close();
  }
});

test("SwarmClient records reputation events and reads them back", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    const nodeId = await client.registerNode("http://127.0.0.1:50052", "desktop");
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
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    assert.equal(await client.getCapacity(), 0);

    await client.registerNode("http://127.0.0.1:50052", "desktop");
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
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    await client.registerNode("http://127.0.0.1:50052", "desktop", "kitchen-mesh");
    const groups = await client.listNodesByLocality();
    assert.equal((groups["kitchen-mesh"] as unknown[]).length, 1);
  } finally {
    server.close();
  }
});

test("SwarmClient registers, heartbeats, lists, and deregisters a peer", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
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
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    const result = await client.classify("hello");
    assert.deepEqual(result, { safe: true, categories: [] });
  } finally {
    server.close();
  }
});

test("SwarmClient.registerNode rejects with the server's error detail on a 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    await assert.rejects(
      () => client.registerNode("http://127.0.0.1:50052", "toaster" as any),
      (err: Error) => {
        assert.match(err.message, /deviceTier must be one of/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("SwarmClient.registerNode accepts an optional servesModel", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
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
    const client = new SwarmClient(baseUrl, TEST_AUTH_TOKEN);
    await client.registerNode(stub.endpoint, "desktop", undefined, "tinyllama-1.1b");

    const result = await client.generate("The capital of France is", "tinyllama-1.1b");
    assert.deepEqual(result, { text: "Paris." });
  } finally {
    server.close();
    stub.server.close();
  }
});
