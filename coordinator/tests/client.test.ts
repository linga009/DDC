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

test("SwarmClient.registerNode rejects with the server's error detail on a 400", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const client = new SwarmClient(baseUrl);
    await assert.rejects(
      () => client.registerNode("127.0.0.1:50052", "toaster" as any),
      (err: Error) => {
        assert.match(err.message, /deviceTier must be one of/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});
