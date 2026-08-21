import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeRegistry, UNGROUPED_LOCALITY } from "../src/registry.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";

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

test("listActive excludes a node the reputation tracker has marked untrusted", () => {
  const registry = new NodeRegistry();
  const reputation = new ReputationTracker(3, 0.5);
  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  assert.equal(registry.listActive(reputation).length, 1);

  for (let i = 0; i < 3; i++) {
    reputation.recordDisagreement(nodeId);
  }
  assert.equal(registry.listActive(reputation).length, 0);
});

test("listActive without a reputation tracker argument behaves exactly as before (backward compatible)", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop");
  assert.equal(registry.listActive().length, 1);
});

test("register accepts an optional localityGroup and it is returned via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");
  const [node] = registry.listActive();
  assert.equal(node.localityGroup, "kitchen-mesh");
});

test("register without a localityGroup leaves it undefined via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop");
  const [node] = registry.listActive();
  assert.equal(node.localityGroup, undefined);
});

test("groupByLocality groups nodes that share the same localityGroup together", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");
  registry.register("127.0.0.1:50053", "android", "kitchen-mesh");
  registry.register("127.0.0.1:50054", "desktop", "office-mesh");

  const groups = registry.groupByLocality();

  assert.equal(groups.get("kitchen-mesh")?.length, 2);
  assert.equal(groups.get("office-mesh")?.length, 1);
});

test("groupByLocality buckets nodes with no localityGroup under UNGROUPED_LOCALITY", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop");

  const groups = registry.groupByLocality();

  assert.equal(groups.get(UNGROUPED_LOCALITY)?.length, 1);
});

test("groupByLocality excludes a node the reputation tracker has marked untrusted", () => {
  const registry = new NodeRegistry();
  const reputation = new ReputationTracker(3, 0.5);
  const nodeId = registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");

  assert.equal(registry.groupByLocality(reputation).get("kitchen-mesh")?.length, 1);

  for (let i = 0; i < 3; i++) {
    reputation.recordDisagreement(nodeId);
  }
  assert.equal(registry.groupByLocality(reputation).has("kitchen-mesh"), false);
});

test("groupByLocality excludes an expired node, matching listActive's pruning", () => {
  let now = 1000;
  const registry = new NodeRegistry(() => now, 30000);
  registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");

  now += 30001;
  const groups = registry.groupByLocality();

  assert.equal(groups.has("kitchen-mesh"), false);
});

test("register accepts an optional servesModel and it is returned via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop", undefined, "tinyllama-1.1b");
  const [node] = registry.listActive();
  assert.equal(node.servesModel, "tinyllama-1.1b");
});

test("register without a servesModel leaves it undefined via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop");
  const [node] = registry.listActive();
  assert.equal(node.servesModel, undefined);
});

test("register accepts both localityGroup and servesModel together", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop", "kitchen-mesh", "tinyllama-1.1b");
  const [node] = registry.listActive();
  assert.equal(node.localityGroup, "kitchen-mesh");
  assert.equal(node.servesModel, "tinyllama-1.1b");
});

test("register called twice with the same endpoint returns the same nodeId and does not grow size()", () => {
  const registry = new NodeRegistry();
  const first = registry.register("http://127.0.0.1:50052", "desktop");
  const second = registry.register("http://127.0.0.1:50052", "desktop");

  assert.equal(first, second);
  assert.equal(registry.size(), 1);
});

test("nodeId is a 64-character lowercase hex string (sha256 of the endpoint), not a UUID", () => {
  const registry = new NodeRegistry();
  const nodeId = registry.register("http://127.0.0.1:50052", "desktop");

  assert.match(nodeId, /^[0-9a-f]{64}$/);
});

test("re-registering the same endpoint with a different deviceTier/localityGroup/servesModel updates the fields in place under the same nodeId", () => {
  const registry = new NodeRegistry();
  const first = registry.register("http://127.0.0.1:50052", "desktop", "kitchen-mesh", "tinyllama-1.1b");
  const second = registry.register("http://127.0.0.1:50052", "android", "office-mesh", "small-7b");

  assert.equal(first, second);
  assert.equal(registry.size(), 1);
  const [node] = registry.listActive();
  assert.equal(node.deviceTier, "android");
  assert.equal(node.localityGroup, "office-mesh");
  assert.equal(node.servesModel, "small-7b");
});

test("registering the same endpoint under three different localityGroup values in sequence never produces more than one active node at a time", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop", "kitchen-mesh");
  registry.register("http://127.0.0.1:50052", "desktop", "office-mesh");
  registry.register("http://127.0.0.1:50052", "desktop", "garage-mesh");

  assert.equal(registry.size(), 1);
  const groups = registry.groupByLocality();
  assert.equal(groups.has("kitchen-mesh"), false);
  assert.equal(groups.has("office-mesh"), false);
  assert.equal(groups.get("garage-mesh")?.length, 1);
});

test("nodeId derivation is case-insensitive in the endpoint", () => {
  const registry = new NodeRegistry();
  const lower = registry.register("http://127.0.0.1:50052", "desktop");
  const upper = registry.register("HTTP://127.0.0.1:50052", "desktop");

  assert.equal(lower, upper);
  assert.equal(registry.size(), 1);
});

test("two different endpoints still produce two different nodeIds", () => {
  const registry = new NodeRegistry();
  const a = registry.register("http://127.0.0.1:50052", "desktop");
  const b = registry.register("http://127.0.0.1:50053", "desktop");

  assert.notEqual(a, b);
});

test("a node's reputation survives an expire-then-re-register cycle at the same endpoint", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);
  const reputation = new ReputationTracker(3, 0.5);

  const firstId = registry.register("http://127.0.0.1:50052", "desktop");
  for (let i = 0; i < 3; i++) {
    reputation.recordDisagreement(firstId);
  }
  assert.equal(reputation.isTrusted(firstId), false);

  now = 30001; // past the 30s timeout, with no heartbeat in between
  assert.equal(registry.listActive(reputation).length, 0); // pruned from the registry
  assert.equal(registry.size(), 0);

  const secondId = registry.register("http://127.0.0.1:50052", "desktop"); // re-register, same endpoint

  assert.equal(secondId, firstId);
  assert.equal(reputation.isTrusted(secondId), false); // still untrusted -- history was never reset
  assert.deepEqual(reputation.getStats(secondId), { agreements: 0, disagreements: 3 });
});
