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
  assert.equal(registry.listActive().length, 1);

  now = 30001; // just past the 30s timeout, with no heartbeat in between
  assert.equal(registry.listActive().length, 0);

  // Gone for good -- it would need to register again to come back.
  assert.equal(registry.heartbeat(nodeId), false);
  assert.equal(registry.listActive().length, 0);
});

test("a node past its timeout cannot be revived by a heartbeat, regardless of whether listActive scanned it first", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);

  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  now = 30001; // past the timeout; no listActive() call has run since expiry,
  // so the entry is still physically sitting in the map -- but heartbeat()
  // must still treat it as expired rather than reviving it, since "past the
  // timeout" is now an unconditional invariant that doesn't depend on
  // whether some unrelated listActive() call happened to prune it first.
  assert.equal(registry.heartbeat(nodeId), false);
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.size(), 0);
});

test("heartbeat still revives a node that is within its timeout window", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);

  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  now = 20000; // within the 30s timeout
  assert.equal(registry.heartbeat(nodeId), true); // refreshes lastSeen to `now`
  assert.equal(registry.listActive().length, 1);

  now = 49999; // 29999ms past the refreshed heartbeat -- still within timeout
  assert.equal(registry.listActive().length, 1);

  now = 50001; // 30001ms past the refreshed heartbeat -- now expired
  assert.equal(registry.listActive().length, 0);
});

test("a custom timeout configured on the registry applies to both listActive and heartbeat", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now, 1000);

  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  now = 1001; // past the custom 1000ms timeout
  assert.equal(registry.heartbeat(nodeId), false);
  assert.equal(registry.listActive().length, 0);
});

test("listActive prunes expired nodes from internal state, not just from its return value", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);

  registry.register("127.0.0.1:50052", "desktop");
  assert.equal(registry.size(), 1);

  now = 30001; // just past the 30s timeout, with no heartbeat in between
  const active = registry.listActive();
  assert.equal(active.length, 0);
  assert.equal(registry.size(), 0); // genuinely removed, not just filtered out
});

test("heartbeat prunes an expired node from internal state, not just returns false", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);

  const nodeId = registry.register("127.0.0.1:50052", "desktop");
  assert.equal(registry.size(), 1);

  now = 30001; // just past the 30s timeout
  assert.equal(registry.heartbeat(nodeId), false);
  assert.equal(registry.size(), 0); // genuinely removed by heartbeat itself
});

test("multiple nodes are tracked independently", () => {
  const registry = new NodeRegistry();
  const a = registry.register("127.0.0.1:50052", "desktop");
  const b = registry.register("127.0.0.1:50053", "android");

  assert.notEqual(a, b);
  assert.equal(registry.listActive().length, 2);
});
