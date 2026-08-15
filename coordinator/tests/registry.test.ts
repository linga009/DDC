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
